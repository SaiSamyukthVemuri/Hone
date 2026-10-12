import { describe, expect, it } from "vitest";
import { effectiveInbound, inboundReaches } from "@/lib/sms/inbound-routing";

// Twilio documents (service-resource, checked 2026-10-12): with
// use_inbound_webhook_on_number ON, the number's webhook overrides the
// service's inbound_request_url; with it OFF and inbound_request_url null,
// inbound is disabled. Anything unreported is UNKNOWN, and unknown never passes.

const HONE = "https://hone.care/api/twilio/inbound-sms";
const OTHER = "https://elsewhere.example/sms";

describe("effectiveInbound", () => {
  it.each([
    ["flag off: the service URL", { serviceInboundUrl: HONE, useInboundWebhookOnNumber: false, numberSmsUrl: OTHER }, { kind: "service", url: HONE }],
    ["flag off, no service URL: disabled", { serviceInboundUrl: null, useInboundWebhookOnNumber: false, numberSmsUrl: HONE }, { kind: "disabled" }],
    ["flag on: the number's URL overrides the service's", { serviceInboundUrl: HONE, useInboundWebhookOnNumber: true, numberSmsUrl: OTHER }, { kind: "number", url: OTHER }],
    ["flag on, the number has none: never assumed", { serviceInboundUrl: HONE, useInboundWebhookOnNumber: true, numberSmsUrl: null }, { kind: "number_url_missing" }],
    ["flag unreported: unknown", { serviceInboundUrl: HONE, useInboundWebhookOnNumber: null, numberSmsUrl: HONE }, { kind: "unknown", missing: "use_inbound_webhook_on_number" }],
    ["flag on, the number's URL unreported: unknown", { serviceInboundUrl: HONE, useInboundWebhookOnNumber: true, numberSmsUrl: undefined }, { kind: "unknown", missing: "number_sms_url" }],
  ] as const)("%s", (_label, facts, expected) => {
    expect(effectiveInbound(facts)).toEqual(expected);
  });
});

describe("inboundReaches", () => {
  it("only an exact effective match is yes; unknown stays unknown", () => {
    expect(inboundReaches({ serviceInboundUrl: HONE, useInboundWebhookOnNumber: false, numberSmsUrl: null }, HONE)).toBe("yes");
    expect(inboundReaches({ serviceInboundUrl: OTHER, useInboundWebhookOnNumber: true, numberSmsUrl: HONE }, HONE)).toBe("yes");
    expect(inboundReaches({ serviceInboundUrl: HONE, useInboundWebhookOnNumber: true, numberSmsUrl: OTHER }, HONE)).toBe("no");
    expect(inboundReaches({ serviceInboundUrl: `${HONE}/`, useInboundWebhookOnNumber: false, numberSmsUrl: null }, HONE)).toBe("no");
    expect(inboundReaches({ serviceInboundUrl: null, useInboundWebhookOnNumber: false, numberSmsUrl: HONE }, HONE)).toBe("no");
    expect(inboundReaches({ serviceInboundUrl: HONE, useInboundWebhookOnNumber: null, numberSmsUrl: HONE }, HONE)).toBe("unknown");
    expect(inboundReaches({ serviceInboundUrl: HONE, useInboundWebhookOnNumber: true, numberSmsUrl: undefined }, HONE)).toBe("unknown");
  });
});
