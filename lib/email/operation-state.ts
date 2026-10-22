import { EMAIL_LEDGER_TAG } from "./resend-webhook";
import { isEmailLedgerId } from "./delivery-ledger";
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
  if (!payload || Object.keys(payload).some((key) => !["from", "to", "subject", "html", "text", "replyTo", "attachments", "tags"].includes(key))) return false;
  if (["from", "to", "subject", "html", "text"].some((key) => typeof payload[key] !== "string")) return false;
  if (payload.replyTo !== undefined && typeof payload.replyTo !== "string") return false;
  if (payload.attachments !== undefined) {
    if (!Array.isArray(payload.attachments)) return false;
    if (!payload.attachments.every((value) => {
      const attachment = record(value);
      return attachment !== null && Object.keys(attachment).every((key) => key === "filename" || key === "content") && typeof attachment.filename === "string" && Buffer.isBuffer(attachment.content);
    })) return false;
  }
  if (payload.tags !== undefined) {
    if (!Array.isArray(payload.tags) || payload.tags.length !== 1) return false;
    const tag = record(payload.tags[0]);
    if (!tag || Object.keys(tag).length !== 2 || tag.name !== EMAIL_LEDGER_TAG || !isEmailLedgerId(tag.value)) return false;
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
    payload.tags?.map((tag) => [tag.name, tag.value]) ?? null,
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


export type EmailOperationAuthority = Readonly<Record<"appointment" | "client" | "studio" | "intake" | "service" | "practitioner", string>>;
export type EmailIntakeRender = Readonly<{
  kind: "reminder_24h" | "reminder_2h"; clientEmail: string; studioName: string;
  timezone: string; startsAt: string; intake: Readonly<{ id: string; status: "in_progress" }>;
  replyTo: null; attachments: null;
}>;
export type EmailReminderRender = Readonly<{
  appointment: Readonly<{ id: string; studio_id: string; client_id: string; status: "confirmed"; starts_at: string; ends_at: string; duration_minutes: number; service_id: string | null; practitioner_id: string | null }>;
  client: Readonly<{ id: string; name: string; email: string }>;
  studio: Readonly<{ id: string; name: string; address: string | null; slug: string | null; timezone: string; owner_email: string | null; postcare_contact_email: string | null; show_treatment_time_to_clients: boolean; send_24h_reminders: boolean; send_2h_reminders: boolean; send_intake_reminders: boolean; client_cancellation_enabled: boolean | null; client_reschedule_enabled: boolean | null }>;
  service: Readonly<{ id: string; name: string; pre_care_instructions: string | null }> | null;
  practitioner: Readonly<{ id: string; display_name: string | null; email: string | null }> | null;
  treatmentTime: Readonly<{ totalMinutes: number; sessionCount: number }> | null;
  intake: Readonly<{ id: string; status: "in_progress" }> | null; attachments: null;
}>;
export type EmailOperationRender = EmailIntakeRender | EmailReminderRender;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof v[k] === "string");
const nullableStrings = (v: Record<string, unknown>, keys: string[]) => keys.every((k) => v[k] === null || typeof v[k] === "string");
const timestamp = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const intakeRender = (v: unknown) => { const row = record(v); return row !== null && exact(row, ["id", "status"]) && typeof row.id === "string" && row.id.length > 0 && row.status === "in_progress"; };

/** Closed DB-to-trusted-server DTO; never an API/browser/log representation.
 * Returns a detached deep-frozen copy. No normalized fields may drift from
 * the exact JSONB object compared by authorize and original observation. */
export function parseEmailOperationRender(value: unknown): EmailOperationRender | null {
  const v = record(value); if (!v) return null;
  if ("kind" in v) {
    if (!exact(v, ["kind", "clientEmail", "studioName", "timezone", "startsAt", "intake", "replyTo", "attachments"]) ||
      !["reminder_24h", "reminder_2h"].includes(String(v.kind)) || !strings(v, ["clientEmail", "studioName", "timezone"]) ||
      !(v.clientEmail as string).includes("@") || !timestamp(v.startsAt) || !intakeRender(v.intake) || v.replyTo !== null || v.attachments !== null) return null;
  } else {
    if (!exact(v, ["appointment", "client", "studio", "service", "practitioner", "treatmentTime", "intake", "attachments"]) || v.attachments !== null) return null;
    const a = record(v.appointment), c = record(v.client), s = record(v.studio);
    if (!a || !c || !s || !exact(a, ["id", "studio_id", "client_id", "status", "starts_at", "ends_at", "duration_minutes", "service_id", "practitioner_id"]) ||
      !strings(a, ["id", "studio_id", "client_id"]) || a.status !== "confirmed" || !timestamp(a.starts_at) || !timestamp(a.ends_at) ||
      !Number.isSafeInteger(a.duration_minutes) || !nullableStrings(a, ["service_id", "practitioner_id"]) ||
      !exact(c, ["id", "name", "email"]) || !strings(c, ["id", "name", "email"]) || !(c.email as string).includes("@") ||
      !exact(s, ["id", "name", "address", "slug", "timezone", "owner_email", "postcare_contact_email", "show_treatment_time_to_clients", "send_24h_reminders", "send_2h_reminders", "send_intake_reminders", "client_cancellation_enabled", "client_reschedule_enabled"]) ||
      !strings(s, ["id", "name", "timezone"]) || !nullableStrings(s, ["address", "slug", "owner_email", "postcare_contact_email"]) ||
      !["show_treatment_time_to_clients", "send_24h_reminders", "send_2h_reminders", "send_intake_reminders"].every((k) => typeof s[k] === "boolean") ||
      !["client_cancellation_enabled", "client_reschedule_enabled"].every((k) => s[k] === null || typeof s[k] === "boolean") ||
      a.client_id !== c.id || a.studio_id !== s.id) return null;
    for (const [key, fields, required, optional, id] of [
      ["service", ["id", "name", "pre_care_instructions"], ["id", "name"], ["pre_care_instructions"], a.service_id],
      ["practitioner", ["id", "display_name", "email"], ["id"], ["display_name", "email"], a.practitioner_id],
    ] as const) {
      if (id === null) { if (v[key] !== null) return null; }
      else { const r = record(v[key]); if (!r || !exact(r, [...fields]) || !strings(r, [...required]) || !nullableStrings(r, [...optional]) || r.id !== id) return null; }
    }
    if (v.intake !== null && !intakeRender(v.intake)) return null;
    if (s.show_treatment_time_to_clients) {
      const t = record(v.treatmentTime);
      if (!t || !exact(t, ["totalMinutes", "sessionCount"]) || !Number.isSafeInteger(t.totalMinutes) || !Number.isSafeInteger(t.sessionCount) ||
        (t.sessionCount as number) < 0 || (t.sessionCount as number) >= Number.MAX_SAFE_INTEGER) return null;
    } else if (v.treatmentTime !== null) return null;
  }
  const freeze = (node: unknown): unknown => {
    if (node !== null && typeof node === "object") { for (const child of Object.values(node)) freeze(child); Object.freeze(node); }
    return node;
  };
  return freeze(JSON.parse(JSON.stringify(v))) as EmailOperationRender;
}

export function parseEmailOperationAuthority(value: unknown): EmailOperationAuthority | null {
  const v = record(value); const keys = ["appointment", "client", "studio", "intake", "service", "practitioner"];
  return v && exact(v, keys) && keys.every((k) => typeof v[k] === "string" && (/^[0-9]+$/.test(v[k] as string) || (["service", "practitioner"].includes(k) && v[k] === "unassigned"))) ? Object.freeze({ ...v }) as EmailOperationAuthority : null;
}
