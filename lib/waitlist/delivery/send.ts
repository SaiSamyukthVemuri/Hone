import "server-only";
import {
  sendWaitlistEmailIdempotent,
  type IdempotentEmailTransport,
} from "@/lib/email/new-client-waitlist-send";
import { studioEmailIdentity } from "@/lib/email/studio-identity";
import { buildWaitlistInvitationEmail } from "@/lib/email/templates/waitlist-invitation";
import { buildWaitlistRecipientProofEmail } from "@/lib/email/templates/waitlist-recipient-proof";
import {
  challengeMailability,
  classifyDelivery,
  invitationExpiryLabel,
  invitationIsLive,
  invitationSendWindow,
  retryableRefusal,
  terminalRefusal,
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

// ===========================================================================
// ONE INVITATION ID = ONE DELIVERY EVENT
// ===========================================================================
//
// 0193 mints the invitation id and the raw token exactly once and the initial
// server action hands that freshly returned token straight to this module in
// the same request. The token is never persisted, so once this function
// returns, nothing in the system can reconstruct the email that was sent.
//
// There is therefore NO supported "send this invitation again later" operation,
// and no disposition returned here authorizes one — `sameEventRetryAllowed` is
// typed as the literal `false`, so a future branch cannot opt out without a
// compile error. The one retry that IS permitted never leaves a single
// invocation: same id, same in-memory payload object, same key, byte-identical
// attempts, which is what makes the provider replay rather than refuse.
//
// An operator pressing "Resend invitation" is a REISSUE, not a retry: close or
// release the old invitation, re-admit atomically, issue a NEW invitation with
// a new id and a new token, and deliver that as its own event. That lifecycle
// operation belongs to #683, not here.
//
// WHY THIS CLOSES THE PAYLOAD-BYTES QUESTION WITHOUT A PERSISTED EMAIL LEDGER.
// The payload is a pure function of the invitation per BUILD, not across
// builds: a deployment can change the template, FROM_ADDRESS or URL
// construction. Same-key/different-bytes would need a SECOND invocation holding
// the OLD raw token — which the law above forbids. Persisting the serialized
// payload would close it too, and would build exactly the same-invitation retry
// API the product does not want.
//
// ---------------------------------------------------------------------------
// WHAT THIS LAYER CANNOT PROVE, CARRIED TO THE INTEGRATION PR
// ---------------------------------------------------------------------------
//
// This module has NO callers yet, so a call-graph guard written here would be
// vacuously green — worse than absent, because it would look like coverage.
// These belong with the code that first calls it:
//
//   1. The only path into `sendWaitlistInvitationEmail` is
//      admit_new_client_waitlist_entry -> fresh issued result carrying the raw
//      token -> initial delivery. There must be NO
//      "resolve an existing invitation -> send it again" path.
//   2. No call site reconstructs an invitation email from `token_hash` or from
//      an invitation lookup.
//   3. "Resend invitation" resolves to a reissue that produces a new
//      invitation id and a new raw token before any delivery.
//
// What IS proven here: this module takes `invitationUrl` as a required input,
// touches no Supabase client and mentions no `token_hash`, so it cannot rebuild
// a past invitation's email even if asked to.

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
  /** Stored mint time, owned by the database. Anchors the provider
   *  idempotency window below. */
  issuedAt: Date;
  /** Stored expiry, owned by the database. Rendered as an ABSOLUTE instant, so
   *  the copy is both stable across retries (which the event-only key requires)
   *  and still true when delivery is late. */
  expiresAt: Date;
  /** Injected for determinism in tests; defaults to now. */
  now?: Date;
  /** Test seam. Omitted in production, where the shared client is used. */
  transport?: IdempotentEmailTransport | null;
}): Promise<DeliveryResult> {
  const now = args.now ?? new Date();

  // AN EXPIRED INVITATION IS NEVER MAILED. Checked before the render and before
  // any provider call, so a dead invitation costs zero requests. The recipient
  // would otherwise follow a link that cannot work, and the only possible
  // outcome of the send is a dead end. The proof path has always refused an
  // elapsed challenge; the invitation path did not, which was the asymmetry
  // review caught.
  if (!invitationIsLive(args.expiresAt, now)) {
    // TERMINAL: time only moves forward, so this invitation can never become
    // live again. offerResend is false — inviting a retry here would loop the
    // caller through an attempt guaranteed to fail.
    const disposition = terminalRefusal("invitation_expired");
    return {
      disposition,
      log: buildDeliveryLogRecord({
        kind: "invitation",
        studioId: args.studio.id,
        invitationId: args.invitationId,
        disposition: disposition.reason,
      }),
    };
  }

  // BEYOND THE PROVIDER'S RETENTION THE KEY NO LONGER DEDUPLICATES. Presenting
  // it again submits a fresh email instead of replaying, so a late retry would
  // produce the second invitation this path exists to prevent. Deduplicating
  // past that point needs a durable local delivery record, which is schema and
  // out of this lane, so the send is refused rather than issued on a hope.
  //
  // The verdict is TYPED because two very different things once shared one
  // "false": a genuinely stale invitation, and a database clock a moment ahead
  // of the application clock. The first can never succeed; the second succeeds
  // as soon as time advances, and calling it terminal told a caller to discard
  // a perfectly good invitation.
  const window = invitationSendWindow(args.issuedAt, now);
  if (!window.eligible) {
    const disposition =
      window.disposition === "terminal"
        ? terminalRefusal(window.reason)
        : retryableRefusal(window.reason);
    return {
      disposition,
      log: buildDeliveryLogRecord({
        kind: "invitation",
        studioId: args.studio.id,
        invitationId: args.invitationId,
        disposition: disposition.reason,
      }),
    };
  }

  const email = buildWaitlistInvitationEmail({
    invitationUrl: args.invitationUrl,
    // An ABSOLUTE instant, in the studio's timezone. Both previous shapes
    // failed: remaining time drifted between retries and moved the key; the
    // minted window was stable but claimed "3 days" on a send made a day after
    // issuance. A fixed point is stable AND stays true when delivery is late.
    expiresAtLabel: invitationExpiryLabel(args.expiresAt),
  });

  // V1 SENDS AS HONE, NOT AS THE STUDIO — no `studioIdentity` below, which
  // yields exactly `FROM_ADDRESS` with no Reply-To.
  //
  // Passing it would put `studios.name` in the From header and
  // `postcare_contact_email` / `owner_email` in Reply-To: three mutable
  // operator fields, in a payload that must be a pure function of the
  // invitation because the key carries no digest. Renaming a studio or
  // correcting its contact address would move the bytes under an unchanged key,
  // and the provider answers that with `invalid_idempotent_request` rather than
  // a replay. The prospect learns whose offer it is on the invitation page,
  // which renders fresh every visit and has no key to contradict.
  //
  // The send is DECLARED in the client-facing email guard's
  // PLATFORM_IDENTITY_CLIENT_CALLERS list, because it is unbranded yet writes
  // to a prospect — a third case that guard did not previously have a word for.
  //
  // THE PAYLOAD ALSO CARRIES THE RAW BEARER TOKEN, inside the URL. Two reasons
  // this send is event-only, either sufficient alone:
  //
  //   1. IDEMPOTENCY. `eventScope` only PREFIXES the payload digest; it does
  //      not replace it. Any drift in the rendered body minted a new key and
  //      the provider would send a SECOND invitation for one spot.
  //   2. SECRECY. The digest would otherwise be taken over a body containing
  //      the token and transmitted in a header the provider retains. The token
  //      is 256-bit and not enumerable the way a proof code is, but a
  //      credential belongs in the body and nowhere else.
  const outcome = await sendWaitlistEmailIdempotent({
    namespace: "client",
    studioId: args.studio.id,
    // One key per invitation, not per payload. See the header.
    eventScope: args.invitationId,
    to: args.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    payloadCarriesSecret: true,
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
 * REFUSES BEFORE IT SENDS if the minted CHALLENGE is not one this module is
 * willing to mail — already elapsed, or a longer window than Delivery asked
 * for. Both are Delivery's own business; neither is a claim about B2's bound,
 * which is B2's to set. The refusal is classified as an ordinary rejection so
 * the caller's existing branch handles it, and carries its own reason so the
 * cause is not mistaken for a provider fault.
 *
 * NOTE WHICH TTL THIS IS. The object here is the proof CHALLENGE. The
 * B1/B1.5c "<= 30 minutes" hard law governs the MUTATION CAPABILITY that
 * `completeRecipientProof` mints after a challenge is answered — a different
 * object this module never handles. See policy.ts for the three-way split.
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

  const mailability = challengeMailability(args.issuedAt, args.expiresAt, now);
  if (!mailability.mailable) {
    // The reason is carried through rather than collapsed, so an overlong mint
    // is distinguishable from an expired one and from a stale send. They have
    // different causes and different fixes.
    // TERMINAL: every mailability verdict turns on elapsed time or on how the
    // challenge was minted, and neither is changed by trying again. A resend
    // must mint a NEW challenge.
    const disposition = terminalRefusal(`challenge_${mailability.reason}`);
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

  // THE PROOF KEEPS STUDIO BRANDING, AND THE ASYMMETRY IS DELIBERATE.
  //
  // The invitation dropped it because the invitation is RETRIED under one key:
  // a renamed studio moves the bytes while the key stays put, and the provider
  // calls that `invalid_idempotent_request`. A proof is not retried that way.
  // Each challenge is sent once, and a resend MINTS A NEW CHALLENGE and
  // therefore a new id, so two independently-rendered payloads never meet under
  // one key. The only same-key repeat is the bounded internal retry, which
  // reuses the SAME payload object it already built. If proof resends ever
  // start reusing a challenge id, this stops being true and this send has to
  // drop branding exactly as the invitation did.
  //
  // `payloadCarriesSecret` keeps the CODE out of the provider header: without
  // it the key is SHA-256 over the exact payload, the payload is the email
  // body, and the transmitted Idempotency-Key becomes an offline verifier for a
  // small-search-space secret. Demonstrated against this very path before the
  // flag existed; the control lives in
  // tests/security/waitlist-delivery-secret-logging.test.ts.
  //
  // NOTE ON PLACEMENT: both flags sit immediately below, inside the call's
  // first lines, because tests/source-guards/client-facing-email-identity.test.ts
  // looks for `studioIdentity:` within a bounded window after the call marker.
  // Prose pushed between them once made a branded send read as unbranded.
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
