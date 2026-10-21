// DELIVERY-VISIBILITY-04 — the messages an owner can raise a "client says
// they did not receive it" concern about (0221), and what the ledger said when
// they did. Shared by the report form, the owner card and the support queue.

export type ConcernChannel = "email" | "sms";

export type ConcernTarget = { channel: ConcernChannel; purpose: string; label: string };

export const CONCERN_TARGETS: ReadonlyArray<ConcernTarget> = [
  { channel: "email", purpose: "appointment_confirmation", label: "Booking confirmation email" },
  { channel: "email", purpose: "appointment_reminder_24h", label: "24-hour reminder email" },
  { channel: "email", purpose: "appointment_reminder_2h", label: "2-hour reminder email" },
  { channel: "email", purpose: "appointment_cancellation", label: "Cancellation email" },
  { channel: "email", purpose: "appointment_postcare", label: "Postcare email" },
  { channel: "sms", purpose: "appointment_confirmation", label: "Booking confirmation text" },
  { channel: "sms", purpose: "appointment_reminder_24h", label: "24-hour reminder text" },
  { channel: "sms", purpose: "appointment_reminder_2h", label: "2-hour reminder text" },
];

export function concernTargetValue(t: Pick<ConcernTarget, "channel" | "purpose">): string {
  return `${t.channel}:${t.purpose}`;
}

/** Only a value from the closed list above is accepted; anything else is null. */
export function concernTargetFromValue(value: unknown): ConcernTarget | null {
  if (typeof value !== "string") return null;
  return CONCERN_TARGETS.find((t) => concernTargetValue(t) === value) ?? null;
}

export function concernLabel(channel: string, purpose: string): string {
  return CONCERN_TARGETS.find((t) => t.channel === channel && t.purpose === purpose)?.label ?? `${purpose} ${channel}`;
}

/**
 * What the provider had reported when the owner raised the concern, in plain
 * words. Truthful: "delivered" is the recipient's server accepting it, never
 * proof the client saw it; "no record" says Hone did not track that send.
 */
export function ledgerStatusWords(status: string): string {
  switch (status) {
    case "delivered":
      return "the provider reported it delivered to the client's mail server or carrier (not that it was seen)";
    case "accepted":
    case "sent":
    case "queued":
    case "sending":
      return "the provider had accepted it but not yet reported delivery";
    case "delivery_delayed":
      return "the provider was still retrying a temporary delivery problem";
    case "bounced":
    case "undelivered":
      return "the provider reported it was rejected";
    case "failed":
    case "refused":
    case "suppressed":
      return "it was not sent";
    case "skipped":
      return "Hone did not send it";
    case "unknown":
    case "claimed":
      return "its outcome was unknown";
    case "no_record":
      return "Hone has no tracked record of that message";
    default:
      return "its status was unclear";
  }
}
