import { describe, expect, it } from "vitest";
import {
  evaluateInboundStopPreflight,
  expectedInboundWebhookUrl,
  type InboundStopFacts,
} from "@/lib/sms/inbound-stop-preflight";

// WILLOW-STOP-PREFLIGHT-01 (#824): the preflight's own decisions. Synthetic
// identifiers only. UNKNOWN is a blocker, never a pass.

const BASE = "https://hone.example";
const URL_OK = `${BASE}/api/twilio/inbound-sms`;
const ACCOUNT = `AC${"1".repeat(32)}`;

const allProven = (): InboundStopFacts => ({
  env: { TWILIO_WEBHOOK_BASE_URL: BASE, TWILIO_AUTH_TOKEN: "x", NEXT_PUBLIC_APP_ORIGIN: BASE },
  recentSignatureVerifiedCallbacks: 16,
  endpointProbe: { status: 405, redirectedTo: null },
  service: {
    inboundRequestUrl: URL_OK,
    inboundMethod: "POST",
    useInboundWebhookOnNumber: false,
    numberSmsUrl: null,
    numberSmsApplicationSid: null,
    accountSid: ACCOUNT,
  },
  honeAccountSid: ACCOUNT,
  mappedStudioId: "studio-b",
  expectedStudioId: "studio-b",
  stopForwardedToWebhook: true,
});

describe("expectedInboundWebhookUrl", () => {
  it("is the bare https origin plus the route path; a trailing slash on the base is tolerated", () => {
    expect(expectedInboundWebhookUrl({ TWILIO_WEBHOOK_BASE_URL: BASE })).toEqual({ ok: true, url: URL_OK });
    expect(expectedInboundWebhookUrl({ TWILIO_WEBHOOK_BASE_URL: `${BASE}/` })).toEqual({ ok: true, url: URL_OK });
  });

  for (const [why, base, reason] of [
    ["unset", undefined, "base_unset"],
    ["blank", "  ", "base_unset"],
    ["http", "http://hone.example", "base_not_https"],
    ["a path (the route would count it twice)", "https://hone.example/app", "base_has_path_query_or_fragment"],
    ["a query", "https://hone.example?x=1", "base_has_path_query_or_fragment"],
    ["credentials", "https://u:p@hone.example", "base_has_path_query_or_fragment"],
    ["not a URL", "hone.example", "base_unparseable"],
  ] as const) {
    it(`a base with ${why} is refused`, () => {
      expect(expectedInboundWebhookUrl({ TWILIO_WEBHOOK_BASE_URL: base })).toEqual({ ok: false, reason });
    });
  }
});

describe("evaluateInboundStopPreflight", () => {
  it("every fact proven: ready, no blockers", () => {
    const r = evaluateInboundStopPreflight(allProven());
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it("TODAY'S PRODUCTION FACTS: not ready, and every unread studio-service fact is a blocker", () => {
    // Read-only, 2026-10-12: base and token are set (values not readable), 16
    // recent signature-verified callbacks, GET 405 on the apex URL, and no
    // studio sender or service exists yet.
    const r = evaluateInboundStopPreflight({
      env: { TWILIO_WEBHOOK_BASE_URL: undefined, TWILIO_AUTH_TOKEN: "present" },
      recentSignatureVerifiedCallbacks: 16,
      endpointProbe: { status: 405, redirectedTo: null },
    });
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual([
      "base_url",
      "inbound_reaches",
      "signing_account",
      "studio_mapping",
      "stop_forwarded",
      "one_base",
    ]);
    expect(r.checks.find((c) => c.id === "signing_proven")?.status).toBe("pass");
    expect(r.checks.find((c) => c.id === "endpoint_reachable")?.status).toBe("pass");
  });

  const failing: Array<[string, (f: InboundStopFacts) => void, string | string[]]> = [
    ["the www URL on the service", (f) => (f.service!.inboundRequestUrl = "https://www.hone.example/api/twilio/inbound-sms"), "inbound_reaches"],
    ["a trailing slash on the service URL", (f) => (f.service!.inboundRequestUrl = `${URL_OK}/`), "inbound_reaches"],
    ["GET inbound method on the service", (f) => (f.service!.inboundMethod = "GET"), "inbound_reaches"],
    ["the service's inbound method not reported", (f) => (f.service!.inboundMethod = null), "inbound_reaches"],
    ["a TwiML application overriding the number", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_OK, numberSmsMethod: "POST", numberSmsApplicationSid: `AP${"5".repeat(32)}` }), "inbound_reaches"],
    ["the number's application sid not reported", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_OK, numberSmsMethod: "POST", numberSmsApplicationSid: undefined }), "inbound_reaches"],
    ["the number's webhook overrides, and points elsewhere", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: "https://elsewhere.example/sms" }), "inbound_reaches"],
    ["use_inbound_webhook_on_number not reported (null = unknown, never false)", (f) => (f.service!.useInboundWebhookOnNumber = null), "inbound_reaches"],
    ["the flag on, the number's URL not reported", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: undefined }), "inbound_reaches"],
    ["a service in a subaccount", (f) => (f.service!.accountSid = `AC${"2".repeat(32)}`), "signing_account"],
    ["the service mapped to another studio", (f) => (f.mappedStudioId = "studio-a"), "studio_mapping"],
    ["the service mapped to no studio", (f) => (f.mappedStudioId = null), "studio_mapping"],
    ["a redirecting endpoint", (f) => (f.endpointProbe = { status: 307, redirectedTo: "https://hone.example/x" }), "endpoint_reachable"],
    ["an endpoint answering 404", (f) => (f.endpointProbe = { status: 404, redirectedTo: null }), "endpoint_reachable"],
    ["an empty token", (f) => (f.env = { ...f.env, TWILIO_AUTH_TOKEN: "" }), "auth_token"],
    ["STOP consumed by the service", (f) => (f.stopForwardedToWebhook = false), "stop_forwarded"],
    ["no signature-verified callbacks", (f) => (f.recentSignatureVerifiedCallbacks = 0), "signing_proven"],
    ["the base not observed (controls fall back to the app origin, the route to the request URL)", (f) => (f.env = { ...f.env, TWILIO_WEBHOOK_BASE_URL: undefined }), ["base_url", "inbound_reaches", "one_base"]],
  ];
  for (const [why, mutate, ids] of failing) {
    const want = Array.isArray(ids) ? ids : [ids];
    it(`${why}: blocked on ${want.join(", ")}`, () => {
      const f = allProven();
      mutate(f);
      const r = evaluateInboundStopPreflight(f);
      expect(r.ready).toBe(false);
      expect(r.blockers).toEqual(want);
    });
  }

  it("a redirect is reported as a redirect (Twilio would sign one URL and land on another)", () => {
    const f = allProven();
    f.endpointProbe = { status: 307, redirectedTo: "https://hone.example/x" };
    expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "endpoint_reachable")?.detail).toMatch(/redirects/);
  });

  it("an http base: blocked on the base, and so on everything that must match it", () => {
    const f = allProven();
    f.env = { ...f.env, TWILIO_WEBHOOK_BASE_URL: "http://hone.example" };
    expect(evaluateInboundStopPreflight(f).blockers).toEqual(["base_url", "inbound_reaches", "one_base"]);
  });

  it("the service URL is compared to the URL built from the base, not to a constant", () => {
    const f = allProven();
    f.env = { ...f.env, TWILIO_WEBHOOK_BASE_URL: "https://other.example", NEXT_PUBLIC_APP_ORIGIN: "https://other.example" };
    expect(evaluateInboundStopPreflight(f).blockers).toEqual(["inbound_reaches"]);
  });

  it("WITH #863: the base wins over any app origin, so the controls and the route agree", () => {
    for (const origin of ["https://www.hone.example", "https://hone.example/app", undefined]) {
      const f = allProven();
      f.env = { ...f.env, NEXT_PUBLIC_APP_ORIGIN: origin, VERCEL_URL: "hone-abc.vercel.app" };
      expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
    }
  });

  it("the number's own webhook, when it overrides and is exactly the expected URL, passes (with its own method)", () => {
    const f = allProven();
    Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_OK, numberSmsMethod: "POST", numberSmsApplicationSid: null, inboundRequestUrl: null });
    expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
    f.service!.numberSmsMethod = "GET";
    const r = evaluateInboundStopPreflight(f);
    expect(r.blockers).toEqual(["inbound_reaches"]);
    expect(r.checks.find((c) => c.id === "inbound_reaches")?.detail).toMatch(/GET, not POST/);
  });

  it("a number-level override is decided without the (irrelevant) service URL", () => {
    const f = allProven();
    f.service = { useInboundWebhookOnNumber: true, numberSmsUrl: URL_OK, numberSmsMethod: "POST", numberSmsApplicationSid: null, accountSid: ACCOUNT };
    expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
  });

  it("with the flag OFF, an unread service URL is still unknown", () => {
    const f = allProven();
    f.service = { useInboundWebhookOnNumber: false, inboundMethod: "POST", accountSid: ACCOUNT };
    const r = evaluateInboundStopPreflight(f);
    expect(r.blockers).toEqual(["inbound_reaches"]);
    // Not read is UNKNOWN, never reported as "disabled".
    expect(r.checks.find((c) => c.id === "inbound_reaches")?.status).toBe("unknown");
  });

  it("a TwiML application on the number is reported as overriding, and fails", () => {
    const f = allProven();
    Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_OK, numberSmsMethod: "POST", numberSmsApplicationSid: `AP${"5".repeat(32)}` });
    const c = evaluateInboundStopPreflight(f).checks.find((x) => x.id === "inbound_reaches");
    expect(c).toMatchObject({ status: "fail" });
    expect(c?.detail).toMatch(/application/);
  });

  it("inbound DISABLED (flag off, no inbound_request_url) fails and says so", () => {
    const f = allProven();
    f.service!.inboundRequestUrl = null;
    const r = evaluateInboundStopPreflight(f);
    expect(r.blockers).toContain("inbound_reaches");
    expect(r.checks.find((c) => c.id === "inbound_reaches")?.detail).toMatch(/DISABLED/);
  });

  it("the flag on while the number has no URL fails (undocumented, never assumed)", () => {
    const f = allProven();
    Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: null, numberSmsApplicationSid: null });
    const c = evaluateInboundStopPreflight(f).checks.find((x) => x.id === "inbound_reaches");
    expect(c).toMatchObject({ status: "fail" });
    expect(c?.detail).toMatch(/no sms_url/);
  });
});
