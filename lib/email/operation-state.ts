import "server-only";
import type { MinimalEmailTransport } from "./e2e-fake-resend";

// Pure preparation for 0247. These helpers grant no dispatch permission and
// have no database/SDK calls. The existing send path is deliberately unchanged.
export type EmailOperationObservation =
  | { kind: "accepted"; messageId: string }
  | { kind: "definite_refusal" }
  | { kind: "unknown"; reason: "missing_id" | "malformed_reply" | "timeout" | "transport" | "server_error" | "payload_conflict" | "inflight" | "invalid_key" | "unclassified_error" };

type ObservationInput =
  | { kind: "reply"; reply: unknown }
  | { kind: "timeout" | "transport" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Classify only a matching SDK observation, never a caller's assertion of
 * acceptance. The future trusted adapter owns that binding; SQL/ACL review is
 * still required. Raw provider bodies/messages never become returned metadata. */
export function classifyEmailOperationObservation(input: ObservationInput): EmailOperationObservation {
  if (input.kind !== "reply") return { kind: "unknown", reason: input.kind };
  const reply = record(input.reply);
  if (!reply || !("error" in reply)) return { kind: "unknown", reason: "malformed_reply" };
  if (reply.error !== null) {
    if (reply.data != null) return { kind: "unknown", reason: "malformed_reply" };
    const error = record(reply.error);
    if (!error) return { kind: "unknown", reason: "malformed_reply" };
    if (error.name === "invalid_idempotent_request") return { kind: "unknown", reason: "payload_conflict" };
    if (error.name === "concurrent_idempotent_requests") return { kind: "unknown", reason: "inflight" };
    if (error.name === "invalid_idempotency_key") return { kind: "unknown", reason: "invalid_key" };
    if (typeof error.statusCode === "number" && error.statusCode >= 500) return { kind: "unknown", reason: "server_error" };
    if (error.statusCode === 422 && error.name === "validation_error") return { kind: "definite_refusal" };
    return { kind: "unknown", reason: "unclassified_error" };
  }
  const id = record(reply.data)?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id)) {
    return { kind: "unknown", reason: "missing_id" };
  }
  return { kind: "accepted", messageId: id };
}

type WirePayload = Parameters<MinimalEmailTransport["emails"]["send"]>[0];
type RequestContext = Readonly<{ providerAccount: string; providerKey: string; purpose: "reminder_24h" | "reminder_2h" }>;

export function isClosedEmailOperationPayload(value: unknown): value is WirePayload {
  const payload = record(value);
  if (!payload || Object.keys(payload).some((key) => !["from", "to", "subject", "html", "text", "replyTo", "attachments"].includes(key))) return false;
  if (["from", "to", "subject", "html", "text"].some((key) => typeof payload[key] !== "string")) return false;
  if (payload.replyTo !== undefined && typeof payload.replyTo !== "string") return false;
  if (payload.attachments !== undefined) {
    if (!Array.isArray(payload.attachments)) return false;
    if (!payload.attachments.every((value) => {
      const attachment = record(value);
      return attachment !== null && Object.keys(attachment).every((key) => key === "filename" || key === "content") && typeof attachment.filename === "string" && Buffer.isBuffer(attachment.content);
    })) return false;
  }
  return true;
}

function wireRepresentation(payload: WirePayload, context: RequestContext): string | null {
  if (!isClosedEmailOperationPayload(payload)) return null;
  const scope = record(context);
  if (!scope || Object.keys(scope).some((key) => !["providerAccount", "providerKey", "purpose"].includes(key)) || typeof scope.providerAccount !== "string" || typeof scope.providerKey !== "string" || !["reminder_24h", "reminder_2h"].includes(String(scope.purpose))) return null;
  // Exact current transport fields; array order and attachment bytes matter.
  // Optional omission is distinct from an explicitly empty value. No hash is
  // mistaken for reconstructible content, and no content is persisted/logged.
  return JSON.stringify([
    context.providerAccount, context.providerKey, context.purpose,
    payload.from, payload.to, payload.subject, payload.html, payload.text,
    payload.replyTo ?? null,
    payload.attachments?.map((a) => [a.filename, a.content.toString("base64")]) ?? null,
  ]);
}

/** Request-lifetime comparator only. Holds no DB replay representation and
 * exposes no payload/digest. A lost process loses this binding: keep UNKNOWN;
 * do not re-render, remint a token, rotate a key or automatically replay. */
export function bindEmailOperationRequest(payload: WirePayload, context: RequestContext): {
  matches: (candidate: WirePayload, candidateContext: RequestContext) => boolean;
} {
  const frozen = wireRepresentation(payload, context);
  return Object.freeze({ matches: (candidate: WirePayload, candidateContext: RequestContext) => frozen !== null && frozen === wireRepresentation(candidate, candidateContext) });
}

/** Original operation effect only, separate from lease/current-generation
 * projection. A late failure cannot erase positive evidence. This is not a
 * receipt setter, persistence adapter, retry decision or provider proof. */
export function retainEmailOperationObservation(
  previous: EmailOperationObservation,
  observation: EmailOperationObservation,
): EmailOperationObservation {
  if (previous.kind === "accepted") return previous;
  if (observation.kind === "accepted") return observation;
  if (previous.kind === "unknown") return previous;
  return observation;
}
