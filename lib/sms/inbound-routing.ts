// ===========================================================================
// Where, and HOW, Twilio actually delivers an inbound text (a STOP included)
// for one number in one Messaging Service. Pure: it evaluates provider facts
// and calls nothing.
// ===========================================================================
//
// Documented behaviour (checked 2026-10-12):
//   * Services resource (twilio.com/docs/messaging/api/service-resource):
//     `inbound_request_url` is "The URL we call using inbound_method ...
//     When this property is null, receiving inbound messages is disabled";
//     with `use_inbound_webhook_on_number` enabled, "the webhook url defined
//     on the phone number will override the inbound_request_url/fallback_url".
//   * IncomingPhoneNumber resource
//     (twilio.com/docs/phone-numbers/api/incomingphonenumber-resource):
//     `sms_method` may be GET or POST, and a populated `sms_application_sid`
//     makes Twilio ignore the number's `sms_*_url` fields.
//
// Hone's inbound route verifies a signature over FORM-POSTED fields, so only
// an effective route of Hone's exact URL, by POST, with no application
// override, delivers a STOP. Anything the provider did not report is
// UNKNOWN, and unknown is a blocker: it never passes.
// ===========================================================================

import { sameTwilioWebhook } from "./webhook-base";

export type InboundRoutingFacts = {
  serviceInboundUrl: string | null;
  /** The service's inbound_method; null = not reported. */
  serviceInboundMethod?: string | null;
  /** null = not reported. */
  useInboundWebhookOnNumber: boolean | null;
  /** null = the number has none; undefined = not reported. */
  numberSmsUrl: string | null | undefined;
  /** null = empty; undefined = not reported. */
  numberSmsMethod?: string | null | undefined;
  /** null = none; undefined = not reported. */
  numberSmsApplicationSid?: string | null | undefined;
};

export type EffectiveInbound =
  | { kind: "service"; url: string; method: string }
  | { kind: "number"; url: string; method: string }
  /** Flag off and no service URL: Twilio documents inbound as disabled. */
  | { kind: "disabled" }
  /** Flag on and the number has no URL: undocumented, so never assumed. */
  | { kind: "number_url_missing" }
  /** A TwiML application on the number overrides its sms_* URLs. */
  | { kind: "application_override"; applicationSid: string }
  | {
      kind: "unknown";
      missing:
        | "use_inbound_webhook_on_number"
        | "number_sms_url"
        | "number_sms_method"
        | "number_sms_application_sid"
        | "service_inbound_method";
    };

export function effectiveInbound(f: InboundRoutingFacts): EffectiveInbound {
  if (f.useInboundWebhookOnNumber === null) return { kind: "unknown", missing: "use_inbound_webhook_on_number" };
  if (f.useInboundWebhookOnNumber) {
    if (f.numberSmsApplicationSid === undefined) return { kind: "unknown", missing: "number_sms_application_sid" };
    if (f.numberSmsApplicationSid) return { kind: "application_override", applicationSid: f.numberSmsApplicationSid };
    if (f.numberSmsUrl === undefined) return { kind: "unknown", missing: "number_sms_url" };
    if (!f.numberSmsUrl) return { kind: "number_url_missing" };
    if (!f.numberSmsMethod) return { kind: "unknown", missing: "number_sms_method" };
    return { kind: "number", url: f.numberSmsUrl, method: f.numberSmsMethod.toUpperCase() };
  }
  if (!f.serviceInboundUrl) return { kind: "disabled" };
  if (!f.serviceInboundMethod) return { kind: "unknown", missing: "service_inbound_method" };
  return { kind: "service", url: f.serviceInboundUrl, method: f.serviceInboundMethod.toUpperCase() };
}

/**
 * Does inbound reach `requiredUrl` exactly, by POST, with no application
 * override? "unknown" is a BLOCKER for every caller: only "yes" lets a sender
 * be adopted or a route be trusted.
 */
export function inboundReaches(f: InboundRoutingFacts, requiredUrl: string): "yes" | "no" | "unknown" {
  const e = effectiveInbound(f);
  if (e.kind === "unknown") return "unknown";
  // The same endpoint EXACTLY, allowing only a validated Twilio
  // connection-override fragment (lib/sms/webhook-base.ts).
  return (e.kind === "service" || e.kind === "number") && sameTwilioWebhook(e.url, requiredUrl) && e.method === "POST"
    ? "yes"
    : "no";
}
