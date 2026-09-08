import "server-only";
import { createHash } from "crypto";
import { FROM_ADDRESS, resend } from "./client";
import {
  buildFromHeader,
  type StudioEmailIdentity,
} from "@/lib/email/studio-identity";

// ===========================================================================
// P0 EMERGENCY — TENANT-SCOPED, PAYLOAD-DERIVED IDEMPOTENT SEND
// ===========================================================================
//
// WHY THIS IS NOT sendEmailSafely.
//
// The shared helper is correct for its own callers and is left BYTE-UNCHANGED
// by this feature. It is insufficient here for two reasons:
//
//   1. It passes no provider options, so it cannot send an `Idempotency-Key`.
//      Its 15s `Promise.race` timeout does not — and cannot — cancel the
//      request already in flight, so a send may be reported failed and be
//      accepted moments later. Every other caller has a durable row
//      (appointment, receipt, message) to reconcile against. THIS FLOW HAS
//      NONE: the studio email IS the record, so an uncancelled duplicate is an
//      unrecoverable duplicate.
//
//   2. It collapses the provider error into `{ message, retryable }` and
//      discards the error NAME. This flow must distinguish
//      `concurrent_idempotent_requests` (a first attempt is still in flight —
//      genuinely ambiguous) and `invalid_idempotent_request` (same key, a
//      DIFFERENT payload — a refusal that must never read as success) from an
//      ordinary rejection. Exposing that would change the result shape every
//      existing caller consumes.
//
// PROVIDER CONTRACT — verified against the INSTALLED SDK (resend 6.12.3), not
// taken from documentation:
//   * `send(payload, options?: CreateEmailRequestOptions)` where
//     `CreateEmailRequestOptions extends IdempotentRequest`.
//   * `post()` does `headers.set("Idempotency-Key", options.idempotencyKey)`.
//   * `CreateEmailResponse = ({data:{id:string}; error:null} |
//     {error:ErrorResponse; data:null}) & {headers}`, with
//     `ErrorResponse = { message, statusCode, name: RESEND_ERROR_CODE_KEY }`.
//   * Relevant names: `invalid_idempotency_key`, `invalid_idempotent_request`,
//     `concurrent_idempotent_requests`.
//
// ===========================================================================
// THE KEY IDENTITY — two components, both mandatory
// ===========================================================================
//
//   <event namespace> / <server-resolved studio id> / SHA256(exact payload)
//
// PAYLOAD COMPONENT. The provider treats one key presented with two different
// payloads as an ERROR, not a duplicate. A key derived from a hand-maintained
// list of "fields that ought to matter" is therefore a latent defect: the
// moment the payload gains a field the list does not know about, honest
// resubmissions start failing. So the hash is taken over the EXACT payload
// object this module is about to transmit — from, to, subject, html, text.
// There is no second list to keep in sync; if the studio's display name, its
// destination, FROM_ADDRESS, the subject or any template copy changes, the
// bytes change and the key changes with them, automatically.
//
// TENANT COMPONENT. The payload hash ALONE is not enough. Neither
// `studios.name` nor `studios.owner_email` is unique (the only unique column is
// `slug`), so two distinct studio rows can render BYTE-IDENTICAL operational
// emails. Without tenant scope those two genuinely different waitlist requests
// would share a key, the provider would replay the first message id, and the
// second submission would report success while producing no distinct record for
// the second studio — a false success, which is the one failure this design
// exists to prevent.
//
// The tenant component MUST be the server-resolved `studios.id`. Never the
// browser-supplied slug (forgeable), never the display name or owner email
// (not unique — the very reason this component exists).
//
// COROLLARY the callers must honour: the payload must be a PURE FUNCTION of the
// submission. Nothing volatile (a wall clock, a nonce) may appear in it, or two
// submissions of the same details would never collapse.
//
// ===========================================================================
// OPTIONAL THIRD COMPONENT — THE EVENT SCOPE (WAIT-02)
// ===========================================================================
//
// "Same tenant + same bytes = same request" was TRUE while the email WAS the
// record: there was nothing else a resubmission could mean. WAIT-02 made it
// false. A durable entry can be REMOVED and the same person can then REJOIN
// with byte-identical details, which is a genuinely NEW event with its own
// database row — but it renders the same payload for the same studio, so the
// two-component key would replay the first send's response and this module
// would report `accepted` for a message nobody received.
//
// So callers that HAVE a durable event identity pass it as `eventScope`, and
// the key becomes one-per-event instead of one-per-payload.
//
// Callers that do NOT pass it keep their EXACT previous key, byte for byte —
// the notification-commit path still depends on identical resubmissions
// collapsing, because there it really is the same request. The component is
// therefore additive: it does not renumber the v2 marker, because no existing
// key identity changed.
// ===========================================================================

/**
 * The two key namespaces. Studio and client sends MUST never share a key: the
 * recipient and body differ, which is exactly what the provider rejects. The
 * version marker rises with the key IDENTITY, not with template copy — v2
 * records that the tenant component was added.
 */
export type WaitlistKeyNamespace = "studio" | "client";
const KEY_PREFIX: Record<WaitlistKeyNamespace, string> = {
  studio: "hone-waitlist-studio-v2",
  client: "hone-waitlist-client-v2",
};

/** Resend documents a 256-character ceiling for the header value. */
export const IDEMPOTENCY_KEY_MAX = 256;

export type ProviderPayload = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** COMMS-01A. Present only for client-facing sends with a studio authority. */
  replyTo?: string;
};

/**
 * Length-prefixed, and therefore injective: no combination of field contents
 * can serialize to the same bytes as a different combination, which a plain
 * separator would allow whenever a field contained the separator.
 */
function canonicalPayload(p: ProviderPayload): string {
  const fields = [p.from, p.to, p.subject, p.html, p.text];
  // APPENDED, and ONLY when set. A payload without a Reply-To serializes to
  // exactly the bytes it did before this field existed, so every key the
  // notification path has ever minted is unchanged. Length prefixing stays
  // injective across differing field counts: a shorter serialization is a
  // proper prefix of a longer one and an empty field still emits "0:".
  if (p.replyTo) fields.push(p.replyTo);
  return fields.map((f) => `${f.length}:${f}`).join("");
}

/**
 * Derive the provider idempotency key from the tenant, an OPTIONAL durable
 * event identity, and the exact payload.
 *
 * Exported so the tests can pin the identity invariants directly; production
 * callers never pass a key, they pass a namespace + studio id (+ event scope
 * where they have one) and let this module derive it from the payload it is
 * about to send.
 *
 * Omitting `eventScope` yields the EXACT key this function produced before the
 * component existed — that is a contract, not an accident, and it is what lets
 * the notification-commit path keep collapsing identical resubmissions.
 *
 * Length: prefix (22) + "/" + uuid (36) + "/" + optional uuid (36) + "/" +
 * sha256 hex (64) = 124 without the scope, 161 with it, both comfortably inside
 * the provider ceiling.
 */
export function waitlistIdempotencyKey(
  namespace: WaitlistKeyNamespace,
  studioId: string,
  payload: ProviderPayload,
  eventScope?: string | null,
): string {
  const payloadHash = createHash("sha256")
    .update(canonicalPayload(payload), "utf8")
    .digest("hex");
  const scope = typeof eventScope === "string" && eventScope.length > 0
    ? `${eventScope}/`
    : "";
  return `${KEY_PREFIX[namespace]}/${studioId}/${scope}${payloadHash}`;
}

/**
 * Key identity for a send whose PAYLOAD CONTAINS A CREDENTIAL.
 *
 * WHY A SECOND KEY SHAPE EXISTS. `waitlistIdempotencyKey` hashes the exact
 * payload, and that is right for every caller whose body holds no secret: the
 * digest makes the key track the bytes automatically, so a changed subject or
 * destination cannot silently reuse a key. But the header value is transmitted
 * to the provider and retained there, and when the body contains a
 * SMALL-SEARCH-SPACE credential the digest stops being opaque: every other
 * field is deterministic and knowable, so an attacker holding the header can
 * enumerate candidates offline, render, hash and compare until it matches. The
 * key becomes a verifier for the secret.
 *
 * That is not hypothetical here. A recipient proof code is drawn from a space
 * small enough to type, which is orders of magnitude below the 256-bit tokens
 * in lib/portal/tokens.ts, and the attack was demonstrated against this
 * repository's own send path before this function existed.
 *
 * So a credential-bearing send keys on the EVENT ALONE and no payload digest is
 * computed. `eventScope` is REQUIRED rather than optional, because without it
 * there is nothing left to make the key unique.
 *
 * THE COST, STATED. Losing the payload component means the key no longer tracks
 * the bytes, so the caller must satisfy the corollary this module already
 * states for every caller — the payload must be a PURE FUNCTION of the event.
 * If it is not, two sends under one event render different bytes, and the
 * provider answers `invalid_idempotent_request` rather than replaying. The
 * proof path holds up its end by rendering the challenge's AUTHORISED WINDOW
 * rather than the remaining time, which does not drift between attempts.
 *
 * The literal suffix cannot collide with a payload-digest key: that key ends in
 * 64 hex characters, this one ends in a fixed non-hex word.
 */
export function waitlistEventOnlyIdempotencyKey(
  namespace: WaitlistKeyNamespace,
  studioId: string,
  eventScope: string,
): string {
  return `${KEY_PREFIX[namespace]}/${studioId}/${eventScope}/no-payload-digest`;
}

/**
 * Three-way outcome. `ambiguous` is a first-class result, not a flavour of
 * failure: it is the only honest answer when the provider may or may not have
 * taken the request, and it drives distinct user-facing copy.
 */
export type WaitlistSendOutcome =
  | { status: "accepted"; messageId: string }
  | { status: "rejected"; code: string | null }
  | { status: "ambiguous"; reason: "timeout" | "concurrent" | "no_message_id" };

const SEND_TIMEOUT_MS = 15_000;

/** Provider error name meaning "a request under this key is still in flight". */
const CONCURRENT_ERROR = "concurrent_idempotent_requests";

type ProviderResult = {
  data: { id?: string } | null;
  error: { name?: string; message?: string; statusCode?: number | null } | null;
} | undefined;

/** Minimal shape of the client this wrapper needs; lets tests inject a fake. */
export type IdempotentEmailTransport = {
  emails: {
    send: (
      payload: ProviderPayload,
      options?: { idempotencyKey?: string },
    ) => Promise<ProviderResult>;
  };
};

async function attempt(
  transport: IdempotentEmailTransport,
  payload: ProviderPayload,
  idempotencyKey: string,
): Promise<WaitlistSendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"__timeout__">((resolve) => {
      timer = setTimeout(() => resolve("__timeout__"), SEND_TIMEOUT_MS);
    });
    const raced = await Promise.race([
      transport.emails.send(payload, { idempotencyKey }),
      timeout,
    ]);
    if (raced === "__timeout__") {
      // The in-flight request is NOT cancelled and may still be accepted.
      return { status: "ambiguous", reason: "timeout" };
    }
    const result = raced as ProviderResult;
    if (!result) return { status: "ambiguous", reason: "no_message_id" };
    if (result.error) {
      const name = result.error.name ?? null;
      if (name === CONCURRENT_ERROR) {
        // A prior attempt under this exact key is still being processed and may
        // yet succeed: ambiguous, never a clean refusal.
        return { status: "ambiguous", reason: "concurrent" };
      }
      // Everything else, INCLUDING invalid_idempotent_request (same key with a
      // different payload), is a refusal. It must never read as success.
      return { status: "rejected", code: name };
    }
    const id = typeof result.data?.id === "string" ? result.data.id.trim() : "";
    if (id.length === 0) {
      // No error and no usable id: "the provider did not say no", which is not
      // "the provider took custody". With no durable record, that is ambiguous.
      return { status: "ambiguous", reason: "no_message_id" };
    }
    return { status: "accepted", messageId: id };
  } catch {
    // A network throw is indistinguishable from a timeout here: the request may
    // or may not have reached the provider.
    return { status: "ambiguous", reason: "timeout" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send one waitlist email under a tenant-scoped, payload-derived key.
 *
 * On an ambiguous first attempt it makes EXACTLY ONE more attempt with the SAME
 * key and the SAME payload object — which is the point of the key: the provider
 * replays the original response instead of sending twice. Bounded at one retry;
 * there is deliberately no loop.
 *
 * AMBIGUITY IS NOT ERASED BY THE RETRY. Once the first attempt is ambiguous,
 * only an ACCEPTANCE resolves it — a rejection on the retry is a fact about the
 * retry, while the first request was never cancelled and may still have been
 * delivered. The outcome therefore stays ambiguous, carrying the first
 * attempt's reason.
 *
 * A `rejected` first attempt is NOT retried: the provider gave a definite
 * answer and repeating it would only burn quota.
 */
export async function sendWaitlistEmailIdempotent(args: {
  namespace: WaitlistKeyNamespace;
  /** SERVER-RESOLVED studios.id. Never a slug, a name, or an owner email. */
  studioId: string;
  /**
   * Durable identity of the EVENT this send announces (WAIT-02 passes the
   * waitlist entry id). Omit it when the send IS the record and an identical
   * resubmission must collapse.
   */
  eventScope?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * COMMS-01A. Server-resolved studio identity for a CLIENT-facing send.
   * Omitted for studio-facing mail, which stays `Hone <hello@hone.care>`.
   */
  studioIdentity?: StudioEmailIdentity;
  /**
   * The payload contains a credential (a proof code), so it must NOT be hashed
   * into the provider idempotency key. Requires `eventScope`. See
   * `waitlistEventOnlyIdempotencyKey`.
   */
  payloadCarriesSecret?: boolean;
  /** Test seam. Defaults to the shared Resend client. */
  transport?: IdempotentEmailTransport | null;
}): Promise<WaitlistSendOutcome> {
  const transport =
    args.transport !== undefined
      ? args.transport
      : (resend as unknown as IdempotentEmailTransport | null);

  if (!transport) return { status: "rejected", code: "not_configured" };
  if (!args.to || !args.to.includes("@")) {
    return { status: "rejected", code: "invalid_recipient" };
  }
  if (!args.studioId) {
    // Refuse rather than mint an unscoped key: an unscoped key is exactly the
    // cross-tenant collision this design exists to prevent.
    return { status: "rejected", code: "missing_tenant_scope" };
  }
  const eventScopeValue =
    typeof args.eventScope === "string" && args.eventScope.length > 0
      ? args.eventScope
      : null;
  if (args.payloadCarriesSecret && !eventScopeValue) {
    // FAIL CLOSED. Falling back to the payload digest here would put the
    // credential into the transmitted key, which is the one thing this flag
    // exists to prevent — and it would do so silently, at exactly the call
    // site that asked not to.
    return { status: "rejected", code: "missing_event_scope" };
  }

  const payload: ProviderPayload = {
    from: args.studioIdentity
      ? buildFromHeader(args.studioIdentity.displayName)
      : FROM_ADDRESS,
    to: args.to,
    subject: args.subject,
    html: args.html,
    text: args.text,
    ...(args.studioIdentity?.replyTo ? { replyTo: args.studioIdentity.replyTo } : {}),
  };
  // Derived from THIS object — the one about to be sent — plus the tenant, so
  // neither component can drift from what is actually transmitted. A
  // credential-bearing payload takes the event-only shape instead, so the
  // secret never reaches the provider header.
  const idempotencyKey = args.payloadCarriesSecret
    ? waitlistEventOnlyIdempotencyKey(
        args.namespace,
        args.studioId,
        eventScopeValue as string,
      )
    : waitlistIdempotencyKey(
        args.namespace,
        args.studioId,
        payload,
        args.eventScope,
      );

  const first = await attempt(transport, payload, idempotencyKey);
  if (first.status !== "ambiguous") return first;

  // ONE bounded retry, SAME key AND same payload object.
  const second = await attempt(transport, payload, idempotencyKey);

  // ONCE THE FIRST ATTEMPT IS AMBIGUOUS, ONLY AN ACCEPTANCE RESOLVES IT.
  //
  // The retry's answer is about the RETRY. The first request was never
  // cancelled — that is what "ambiguous" means here — so a provider rejecting
  // the second attempt says nothing about whether the first was accepted and
  // delivered. Returning that rejection verbatim reported a definitive refusal
  // for a message that may already be in the recipient's inbox.
  //
  // Downstream that was not merely imprecise. A "rejected" outcome sets
  // `mayInvalidateChallenge`, so a caller could retire a proof code that the
  // first request then delivered, and the recipient would type a code the
  // database had just invalidated.
  //
  // An acceptance DOES resolve it: under one idempotency key the provider
  // replays the original response, so a confirmed acceptance on the retry is a
  // confirmation about the first request too.
  if (second.status === "accepted") return second;

  // Otherwise the uncertainty stands, and it keeps the FIRST attempt's reason:
  // that is where the doubt came from, and the retry's own failure mode is not
  // what a caller needs to reason about.
  return { status: "ambiguous", reason: first.reason };
}
