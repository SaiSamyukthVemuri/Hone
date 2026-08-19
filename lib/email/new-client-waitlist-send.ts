import "server-only";
import { createHash } from "crypto";
import { FROM_ADDRESS, resend } from "./client";

// ===========================================================================
// P0 EMERGENCY — IDEMPOTENT WAITLIST SEND
// ===========================================================================
//
// WHY THIS IS NOT sendEmailSafely.
//
// The shared helper is correct for its own callers and is left BYTE-UNCHANGED
// by this feature. It is not sufficient here for two reasons:
//
//   1. It passes no provider options, so it cannot send an `Idempotency-Key`.
//      Its 15s `Promise.race` timeout does not — and cannot — cancel the
//      request already in flight, so a send may be reported as failed and be
//      accepted moments later. Every other caller has a durable row
//      (appointment, receipt, message) to reconcile against. THIS FLOW HAS
//      NONE: the studio email IS the record, so an uncancelled duplicate is
//      an unrecoverable duplicate.
//
//   2. It collapses the provider error into `{ message, retryable }` and
//      discards the error NAME. This flow must distinguish
//      `concurrent_idempotent_requests` (a first attempt is still in flight —
//      genuinely ambiguous) and `invalid_idempotent_request` (same key, a
//      DIFFERENT payload — a refusal that must never read as success) from an
//      ordinary rejection. Widening the shared helper's contract to expose
//      that would change the result shape every existing caller consumes.
//
// So this is a small, waitlist-local wrapper over the SAME Resend client. Its
// blast radius is exactly this feature.
//
// PROVIDER CONTRACT — mechanically verified against the INSTALLED SDK
// (resend 6.12.3), not taken from documentation:
//   * `send(payload, options?: CreateEmailRequestOptions)` where
//     `CreateEmailRequestOptions extends IdempotentRequest`.
//   * `post()` does `headers.set("Idempotency-Key", options.idempotencyKey)`.
//   * `CreateEmailResponse = ({data:{id:string}; error:null} |
//     {error:ErrorResponse; data:null}) & {headers}` with
//     `ErrorResponse = { message, statusCode, name: RESEND_ERROR_CODE_KEY }`.
//   * Relevant names: `invalid_idempotency_key`, `invalid_idempotent_request`,
//     `concurrent_idempotent_requests`.
//
// THE DESIGN INVARIANT
//
//   SAME IDEMPOTENCY KEY  MUST IMPLY  BYTE-IDENTICAL PROVIDER PAYLOAD.
//
// The provider treats one key presented with two different payloads as an
// ERROR, not a duplicate. So a key derived from a hand-maintained list of
// "fields that ought to matter" is a latent defect: the moment the payload
// gains a field the list does not know about, honest resubmissions start
// failing instead of collapsing.
//
// The key is therefore derived HERE, from the EXACT payload object this module
// is about to transmit — from, to, subject, html and text — hashed over a
// length-prefixed (and so injective) serialization. There is no second list to
// keep in sync. If the studio's display name, its destination address,
// FROM_ADDRESS, the subject or any template copy changes, the payload bytes
// change and the key changes with them, automatically.
//
// The corollary the callers must honour: the payload must be a PURE FUNCTION
// of the submission. Nothing volatile (a wall clock, a nonce) may appear in
// it, or two submissions of the same details would never collapse.
// ===========================================================================

/**
 * The two key namespaces. Studio and client sends MUST never share a key: the
 * recipient and body differ, which is exactly what the provider rejects.
 * Version suffix so a future change in event semantics cannot silently reuse
 * a key minted under the old meaning.
 */
export type WaitlistKeyNamespace = "studio" | "client";
const KEY_PREFIX: Record<WaitlistKeyNamespace, string> = {
  studio: "hone-waitlist-studio-v1",
  client: "hone-waitlist-client-v1",
};

/** Resend documents a 256-character ceiling for the header value. */
export const IDEMPOTENCY_KEY_MAX = 256;

type ProviderPayload = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

/**
 * Length-prefixed, and therefore injective: no combination of field contents
 * can serialize to the same bytes as a different combination, which a plain
 * separator would allow whenever a field contained the separator.
 */
function canonicalPayload(p: ProviderPayload): string {
  return [p.from, p.to, p.subject, p.html, p.text]
    .map((f) => `${f.length}:${f}`)
    .join("");
}

/**
 * Derive the provider idempotency key from the payload itself.
 *
 * Exported for the tests that pin the invariant; production callers never pass
 * a key, they pass a namespace and let this module derive it.
 */
export function waitlistIdempotencyKey(
  namespace: WaitlistKeyNamespace,
  payload: ProviderPayload,
): string {
  const digest = createHash("sha256")
    .update(canonicalPayload(payload), "utf8")
    .digest("hex");
  return `${KEY_PREFIX[namespace]}/${digest}`;
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

/** Provider error names that mean "a request under this key is still in flight". */
const CONCURRENT_ERROR = "concurrent_idempotent_requests";

type ProviderResult = {
  data: { id?: string } | null;
  error: { name?: string; message?: string; statusCode?: number | null } | null;
} | undefined;

/** Minimal shape of the client this wrapper needs; lets tests inject a fake. */
export type IdempotentEmailTransport = {
  emails: {
    send: (
      payload: {
        from: string;
        to: string;
        subject: string;
        html: string;
        text: string;
      },
      options?: { idempotencyKey?: string },
    ) => Promise<ProviderResult>;
  };
};

async function attempt(
  transport: IdempotentEmailTransport,
  payload: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  },
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
        // A prior attempt under this exact key is still being processed. It may
        // yet succeed, so this is ambiguous, never a clean refusal.
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
    // A network throw is indistinguishable from a timeout from here: the
    // request may or may not have reached the provider.
    return { status: "ambiguous", reason: "timeout" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send one waitlist email under a caller-supplied idempotency key.
 *
 * On an ambiguous first attempt it makes EXACTLY ONE more attempt with the
 * SAME key — which is the whole point of the key: the provider replays the
 * original response instead of sending twice. Bounded at one retry; there is
 * deliberately no loop.
 *
 * A `rejected` first attempt is NOT retried: the provider gave a definite
 * answer and repeating it would only burn quota.
 */
export async function sendWaitlistEmailIdempotent(args: {
  namespace: WaitlistKeyNamespace;
  to: string;
  subject: string;
  html: string;
  text: string;
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

  const payload = {
    from: FROM_ADDRESS,
    to: args.to,
    subject: args.subject,
    html: args.html,
    text: args.text,
  };
  // Derived from THIS object — the one that is about to be sent — so the key
  // and the payload cannot drift apart.
  const idempotencyKey = waitlistIdempotencyKey(args.namespace, payload);

  const first = await attempt(transport, payload, idempotencyKey);
  if (first.status !== "ambiguous") return first;

  // ONE bounded retry, SAME key AND the same payload object. Safe precisely
  // because the key makes the provider treat it as the same operation.
  return attempt(transport, payload, idempotencyKey);
}
