// ===========================================================================
// Where Twilio actually sends an inbound text (a STOP included) for one number
// in one Messaging Service. Pure: it evaluates provider facts, calls nothing.
// ===========================================================================
//
// Documented behaviour (twilio.com/docs/messaging/api/service-resource,
// checked 2026-10-12):
//   * `inbound_request_url`: "The URL we call ... when a message is received by
//     any phone number ... in the Service. When this property is null,
//     receiving inbound messages is disabled."
//   * `use_inbound_webhook_on_number`: "If this field is enabled then the
//     webhook url defined on the phone number will override the
//     inbound_request_url/fallback_url defined for the Messaging Service."
//
// So the EFFECTIVE inbound URL is the number's own `sms_url` when the flag is
// on, and the service's `inbound_request_url` when it is off. Anything the
// provider did not report is UNKNOWN, and unknown is a blocker: it never
// passes. A flag that is on while the number has no URL of its own is not
// described by the documentation, so it is a blocker too.
// ===========================================================================

export type InboundRoutingFacts = {
  serviceInboundUrl: string | null;
  /** null = not reported. */
  useInboundWebhookOnNumber: boolean | null;
  /** null = the number has none; undefined = not reported. */
  numberSmsUrl: string | null | undefined;
};

export type EffectiveInbound =
  | { kind: "service"; url: string }
  | { kind: "number"; url: string }
  /** Flag off and no service URL: Twilio documents inbound as disabled. */
  | { kind: "disabled" }
  /** Flag on and the number has no URL: undocumented, so never assumed. */
  | { kind: "number_url_missing" }
  | { kind: "unknown"; missing: "use_inbound_webhook_on_number" | "number_sms_url" };

export function effectiveInbound(f: InboundRoutingFacts): EffectiveInbound {
  if (f.useInboundWebhookOnNumber === null) return { kind: "unknown", missing: "use_inbound_webhook_on_number" };
  if (f.useInboundWebhookOnNumber) {
    if (f.numberSmsUrl === undefined) return { kind: "unknown", missing: "number_sms_url" };
    return f.numberSmsUrl ? { kind: "number", url: f.numberSmsUrl } : { kind: "number_url_missing" };
  }
  return f.serviceInboundUrl ? { kind: "service", url: f.serviceInboundUrl } : { kind: "disabled" };
}

/**
 * Does inbound reach `requiredUrl` exactly? "unknown" is a BLOCKER for every
 * caller: only "yes" lets a sender be adopted or a route be trusted.
 */
export function inboundReaches(f: InboundRoutingFacts, requiredUrl: string): "yes" | "no" | "unknown" {
  const e = effectiveInbound(f);
  if (e.kind === "unknown") return "unknown";
  return (e.kind === "service" || e.kind === "number") && e.url === requiredUrl ? "yes" : "no";
}
