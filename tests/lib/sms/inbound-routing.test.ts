import { describe, expect, it } from "vitest";
import { effectiveInbound, inboundReaches, type InboundRoutingFacts } from "@/lib/sms/inbound-routing";

// Twilio documents (checked 2026-10-12):
//   * Services: with use_inbound_webhook_on_number ON, the number's webhook
//     overrides the service's inbound_request_url; OFF with a null
//     inbound_request_url, inbound is disabled.
//   * IncomingPhoneNumber: sms_method may be GET or POST, and a populated
//     sms_application_sid makes Twilio ignore the sms_* URLs.
// Hone's route needs a form POST to its exact URL. Unreported = UNKNOWN, a blocker.

const HONE = "https://hone.care/api/twilio/inbound-sms";
const OTHER = "https://elsewhere.example/sms";
const APP = "AP" + "1".repeat(32);

const svc = (over: Partial<InboundRoutingFacts> = {}): InboundRoutingFacts => ({
  serviceInboundUrl: HONE, serviceInboundMethod: "POST", useInboundWebhookOnNumber: false,
  numberSmsUrl: null, numberSmsMethod: "POST", numberSmsApplicationSid: null, ...over,
});
const num = (over: Partial<InboundRoutingFacts> = {}): InboundRoutingFacts =>
  svc({ useInboundWebhookOnNumber: true, serviceInboundUrl: OTHER, numberSmsUrl: HONE, ...over });

describe("effectiveInbound", () => {
  it.each([
    ["flag off: the service URL and method", svc(), { kind: "service", url: HONE, method: "POST" }],
    ["flag off, no service URL: disabled", svc({ serviceInboundUrl: null }), { kind: "disabled" }],
    ["flag off, service method unreported: unknown", svc({ serviceInboundMethod: null }), { kind: "unknown", missing: "service_inbound_method" }],
    ["flag on: the number's URL and method override the service's", num(), { kind: "number", url: HONE, method: "POST" }],
    ["flag on, an application on the number overrides its URLs", num({ numberSmsApplicationSid: APP }), { kind: "application_override", applicationSid: APP }],
    ["flag on, application unreported: unknown", num({ numberSmsApplicationSid: undefined }), { kind: "unknown", missing: "number_sms_application_sid" }],
    ["flag on, the number has no URL: never assumed", num({ numberSmsUrl: null }), { kind: "number_url_missing" }],
    ["flag on, the number's URL unreported: unknown", num({ numberSmsUrl: undefined }), { kind: "unknown", missing: "number_sms_url" }],
    ["flag on, the number's method unreported: unknown", num({ numberSmsMethod: undefined }), { kind: "unknown", missing: "number_sms_method" }],
    ["flag unreported: unknown", svc({ useInboundWebhookOnNumber: null }), { kind: "unknown", missing: "use_inbound_webhook_on_number" }],
  ] as const)("%s", (_label, facts, expected) => {
    expect(effectiveInbound(facts)).toEqual(expected);
  });
});

describe("inboundReaches: Hone's exact URL, by POST, no application override", () => {
  it("yes only for the exact URL by POST", () => {
    expect(inboundReaches(svc(), HONE)).toBe("yes");
    expect(inboundReaches(svc({ serviceInboundMethod: "post" }), HONE)).toBe("yes");
    expect(inboundReaches(num(), HONE)).toBe("yes");
  });

  it("no for GET, another URL, a disabled service, a missing number URL, or an application override", () => {
    expect(inboundReaches(svc({ serviceInboundMethod: "GET" }), HONE)).toBe("no");
    expect(inboundReaches(num({ numberSmsMethod: "GET" }), HONE)).toBe("no");
    expect(inboundReaches(svc({ serviceInboundUrl: `${HONE}/` }), HONE)).toBe("no");
    expect(inboundReaches(num({ numberSmsUrl: OTHER, serviceInboundUrl: HONE }), HONE)).toBe("no");
    expect(inboundReaches(svc({ serviceInboundUrl: null }), HONE)).toBe("no");
    expect(inboundReaches(num({ numberSmsUrl: null }), HONE)).toBe("no");
    expect(inboundReaches(num({ numberSmsApplicationSid: APP }), HONE)).toBe("no");
  });

  it("unknown stays unknown", () => {
    for (const f of [
      svc({ useInboundWebhookOnNumber: null }),
      svc({ serviceInboundMethod: null }),
      num({ numberSmsUrl: undefined }),
      num({ numberSmsMethod: undefined }),
      num({ numberSmsApplicationSid: undefined }),
    ]) {
      expect(inboundReaches(f, HONE)).toBe("unknown");
    }
  });
});
