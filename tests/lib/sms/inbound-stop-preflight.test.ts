import { describe, expect, it } from "vitest";
import {
  evaluateInboundStopPreflight,
  expectedInboundWebhookUrl,
  retriesRecoverDelivery,
  type InboundStopFacts,
} from "@/lib/sms/inbound-stop-preflight";

// WILLOW-STOP-PREFLIGHT-01 (#824): the preflight's own decisions. Synthetic
// identifiers only. UNKNOWN is a blocker, never a pass.

const BASE = "https://hone.example";
const URL_OK = `${BASE}/api/twilio/inbound-sms`;
/**
 * Connection overrides whose retries recover EVERY delivery failure (Codex P1s
 * 4254444665, 4264761390): connect/TLS, read timeout and 5xx, one retry or
 * more, and a total budget holding two worst-case attempts (2 * (1000 + 5000)).
 */
const FULL_RETRY = "#ct=1000&rt=5000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&e=ashburn,umatilla";
/**
 * A same-route FALLBACK that recovers its OWN failures (Codex P1 4269949178):
 * retries on connect/TLS, read timeout and 5xx, two explicit edges (Codex P2
 * 4266813200), and 2 * (1000 + 5000) within the default 15000 ms total.
 */
const URL_EDGES = `${URL_OK}#ct=1000&rt=5000&rc=2&rp=4xx,5xx,ct,rt&e=ashburn,umatilla`;
/** FULL_RETRY without its edge list, for tests that set `e` themselves. */
const URL_RETRY_NO_EDGES = `${URL_OK}#ct=1000&rt=5000&tt=15000&rc=2&rp=4xx,5xx,ct,rt`;
const URL_RETRY = `${URL_OK}${FULL_RETRY}`;
/** A live Setting's retries that recover every failure within the assumed 15000 ms total. */
const SETTING_RECOVERY = {
  retryOn: ["HTTP_4XX", "HTTP_5XX", "CONNECTION_TIMEOUT", "READ_TIMEOUT"],
  retryCount: 2,
  connectTimeoutMs: 1000,
  readTimeoutMs: 5000,
  edgeZones: "omitted" as const,
};
const ACCOUNT = `AC${"1".repeat(32)}`;

const allProven = (): InboundStopFacts => ({
  env: { TWILIO_WEBHOOK_BASE_URL: BASE, TWILIO_AUTH_TOKEN: "x", NEXT_PUBLIC_APP_ORIGIN: BASE },
  // A signature-verified callback after the current token and base went live.
  signatureProof: { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: "2026-10-01T00:00:00Z" },
  endpointProbe: { status: 405, redirectedTo: null },
  service: {
    inboundRequestUrl: URL_RETRY,
    inboundMethod: "POST",
    useInboundWebhookOnNumber: false,
    numberSmsUrl: null,
    numberSmsApplicationSid: null,
    accountSid: ACCOUNT,
    checkedNumber: "+14165550100",
  },
  // Routed sends pin From to the checked number (draft #858).
  routedFromNumber: "+14165550100",
  // No exact, prefix or default Webhook Rule matches the inbound URL.
  webhookRules: { matched: false },
  // Static Proxy off, so the URL's e= list is real (Codex P2 4267597875).
  staticProxyEnabled: false,
  // The Webhooks configuration has settled (Operations COMPLETED, unchanged >= 90 s).
  webhookPropagation: { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 3600 },
  honeAccountSid: ACCOUNT,
  mappedStudioId: "studio-b",
  expectedStudioId: "studio-b",
  // The approved live STOP was accepted and stamped phone-wide.
  liveStopObservation: { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: true, observedAt: "2026-10-12T12:00:00Z" },
  // The service forwards keyword messages, unchanged since before that STOP.
  optOutConfiguration: { dropsKeywordMessages: false, lastChangedAt: "2026-10-01T00:00:00Z" },
  // The handler deployment and database migration now serving STOP predate that STOP.
  currentActivation: { handlerDeployedAt: "2026-10-11T00:00:00Z", databaseMigratedAt: "2026-10-10T00:00:00Z" },
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
    // studio sender or service exists yet. When the current token and base
    // became active was NOT read, so the callbacks prove nothing yet (Codex P1
    // 4251931839).
    const r = evaluateInboundStopPreflight({
      env: { TWILIO_WEBHOOK_BASE_URL: undefined, TWILIO_AUTH_TOKEN: "present" },
      signatureProof: { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: null },
      endpointProbe: { status: 405, redirectedTo: null },
    });
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual([
      "base_url",
      "signing_proven",
      "inbound_reaches",
      "webhook_rules",
      "signing_account",
      "studio_mapping",
      "stop_forwarded",
      "one_base",
    ]);
    expect(r.checks.find((c) => c.id === "signing_proven")?.status).toBe("unknown");
    expect(r.checks.find((c) => c.id === "endpoint_reachable")?.status).toBe("pass");
  });

  const failing: Array<[string, (f: InboundStopFacts) => void, string | string[]]> = [
    ["the www URL on the service", (f) => (f.service!.inboundRequestUrl = "https://www.hone.example/api/twilio/inbound-sms"), "inbound_reaches"],
    ["a trailing slash on the service URL", (f) => (f.service!.inboundRequestUrl = `${URL_OK}/`), "inbound_reaches"],
    ["GET inbound method on the service", (f) => (f.service!.inboundMethod = "GET"), "inbound_reaches"],
    ["the service's inbound method not reported", (f) => (f.service!.inboundMethod = null), "inbound_reaches"],
    ["a TwiML application overriding the number", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: `AP${"5".repeat(32)}` }), "inbound_reaches"],
    ["the number's application sid not reported", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: undefined }), "inbound_reaches"],
    ["the number's webhook overrides, and points elsewhere", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: "https://elsewhere.example/sms" }), "inbound_reaches"],
    ["use_inbound_webhook_on_number not reported (null = unknown, never false)", (f) => (f.service!.useInboundWebhookOnNumber = null), "inbound_reaches"],
    ["the flag on, the number's URL not reported", (f) => Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: undefined }), "inbound_reaches"],
    ["a service in a subaccount", (f) => (f.service!.accountSid = `AC${"2".repeat(32)}`), "signing_account"],
    ["the service mapped to another studio", (f) => (f.mappedStudioId = "studio-a"), "studio_mapping"],
    ["the service mapped to no studio", (f) => (f.mappedStudioId = null), "studio_mapping"],
    ["a redirecting endpoint", (f) => (f.endpointProbe = { status: 307, redirectedTo: "https://hone.example/x" }), "endpoint_reachable"],
    ["an endpoint answering 404", (f) => (f.endpointProbe = { status: 404, redirectedTo: null }), "endpoint_reachable"],
    ["an empty token", (f) => (f.env = { ...f.env, TWILIO_AUTH_TOKEN: "" }), "auth_token"],
    ["STOP consumed by the service", (f) => (f.liveStopObservation = { reachedRoute: false, routeStatus: null, phoneWideOptOutStamped: null }), "stop_forwarded"],
    ["no signature-verified callbacks", (f) => (f.signatureProof = { lastVerifiedCallbackAt: null, credentialsActiveSince: "2026-10-01T00:00:00Z" }), "signing_proven"],
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
    Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null, inboundRequestUrl: null });
    expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
    f.service!.numberSmsMethod = "GET";
    const r = evaluateInboundStopPreflight(f);
    expect(r.blockers).toEqual(["inbound_reaches"]);
    expect(r.checks.find((c) => c.id === "inbound_reaches")?.detail).toMatch(/GET, not POST/);
  });

  it("a number-level override is decided without the (irrelevant) service URL", () => {
    const f = allProven();
    f.service = { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null, accountSid: ACCOUNT, checkedNumber: "+14165550100" };
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

  describe("SENDER POOL: with the number override on, replies go to whichever number sent", () => {
    const AP = `AP${"5".repeat(32)}`;
    const numberRouted = (): InboundStopFacts => {
      const f = allProven();
      Object.assign(f.service!, {
        useInboundWebhookOnNumber: true,
        numberSmsUrl: URL_RETRY,
        numberSmsMethod: "POST",
        numberSmsApplicationSid: null,
        checkedNumber: "+14165550100",
      });
      f.routedFromNumber = undefined;
      return f;
    };

    it("pinned outbound (From = the checked number): ready without reading the pool", () => {
      const f = numberRouted();
      f.routedFromNumber = "+14165550100";
      expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
    });

    it("not pinned and the pool unread: blocked (unknown)", () => {
      const f = numberRouted();
      const r = evaluateInboundStopPreflight(f);
      expect(r.blockers).toEqual(["sender_pool"]);
      expect(r.checks.find((c) => c.id === "sender_pool")?.status).toBe("unknown");
    });

    it("pinned to a DIFFERENT number than the one checked: not pinned", () => {
      const f = numberRouted();
      f.routedFromNumber = "+14165550199";
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["sender_pool"]);
    });

    it("not pinned, every pool number correct: ready", () => {
      const f = numberRouted();
      f.service!.senderPool = [
        { phoneNumber: "+14165550100", smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: null },
        { phoneNumber: "+14165550101", smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: null },
      ];
      expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
    });

    for (const [why, bad] of [
      ["another URL", { smsUrl: "https://elsewhere.example/sms", smsMethod: "POST", smsApplicationSid: null }],
      ["GET", { smsUrl: URL_RETRY, smsMethod: "GET", smsApplicationSid: null }],
      ["an application override", { smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: AP }],
    ] as const) {
      it(`not pinned, one pool number with ${why}: blocked (fail)`, () => {
        const f = numberRouted();
        f.service!.senderPool = [
          { phoneNumber: "+14165550100", smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: null },
          { phoneNumber: "+14165550101", ...bad },
        ];
        const r = evaluateInboundStopPreflight(f);
        expect(r.blockers).toEqual(["sender_pool"]);
        expect(r.checks.find((c) => c.id === "sender_pool")?.status).toBe("fail");
      });
    }

    it("not pinned, an EMPTY pool list proves nothing: blocked (unknown)", () => {
      const f = numberRouted();
      f.service!.senderPool = [];
      expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")?.status).toBe("unknown");
    });

    it("not pinned, one pool number unreported: blocked (unknown)", () => {
      const f = numberRouted();
      f.service!.senderPool = [
        { phoneNumber: "+14165550100", smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: null },
        { phoneNumber: "+14165550101", smsUrl: undefined },
      ];
      expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")?.status).toBe("unknown");
    });

    it("with the override OFF, the service URL serves every number: no pool check", () => {
      const f = allProven();
      expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")).toBeUndefined();
    });
  });

  it("a TwiML application on the number is reported as overriding, and fails", () => {
    const f = allProven();
    Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: `AP${"5".repeat(32)}` });
    const c = evaluateInboundStopPreflight(f).checks.find((x) => x.id === "inbound_reaches");
    expect(c).toMatchObject({ status: "fail" });
    expect(c?.detail).toMatch(/application/);
  });

  describe("Twilio connection overrides in the fragment (omitted from the request and the signature)", () => {
    for (const frag of [
      "#rp=5xx",
      "#ct=1000&rt=5000&rp=4xx,5xx",
      "#rc=2&tt=15000&sni=n&e=ashburn",
      // Twilio's own "example with all overrides":
      "#ct=500&rt=1000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&sni=y&e=dublin,sydney",
      "#ct=100&rt=15000&rc=0&e=ashburn-ix",
    ]) {
      it(`the service URL with "${frag}" reaches the expected URL`, () => {
        const f = allProven();
        f.service!.inboundRequestUrl = `${URL_OK}${frag}`;
        expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "inbound_reaches")?.status).toBe("pass");
      });
    }

    for (const [why, frag] of [
      ["an empty fragment", "#"],
      ["a bare key with no value", "#rp"],
      ["an empty value", "#ct="],
      ["ct below 100", "#ct=0"],
      ["ct above 10000", "#ct=10001"],
      ["rt above 15000", "#rt=15001"],
      ["tt below 100", "#tt=99"],
      ["rc above 5", "#rc=6"],
      ["a negative retry count", "#rc=-1"],
      ["a non-integer timeout", "#ct=5s"],
      ["a fractional timeout", "#ct=500.5"],
      ["an exponent-form timeout", "#rt=1e3"],
      ["an undocumented retry policy", "#rp=3xx"],
      ["an empty item in a retry-policy list", "#rp=5xx,"],
      ["sni other than y/n", "#sni=on"],
      ["an unknown edge", "#e=mars"],
      ["a duplicated key", "#ct=500&ct=600"],
      ["an empty pair", "#ct=500&"],
      // Stricter rules of the shared normalizer (lib/sms/webhook-base.ts, #863):
      ["a leading zero", "#ct=0500"],
      ["a signed number", "#rc=+1"],
      ["a duplicated retry-policy item", "#rp=5xx,5xx"],
      ["a duplicated edge", "#e=dublin,dublin"],
    ] as const) {
      it(`${why} (${frag}) is never certified`, () => {
        const f = allProven();
        f.service!.inboundRequestUrl = `${URL_OK}${frag}`;
        const r = evaluateInboundStopPreflight(f);
        expect(r.blockers).toEqual(["inbound_reaches"]);
        expect(r.checks.find((c) => c.id === "inbound_reaches")?.detail).toMatch(/connection overrides/);
      });
    }

    it("a fragment that is not connection overrides fails, and says why", () => {
      const f = allProven();
      f.service!.inboundRequestUrl = `${URL_OK}#studio=b`;
      const r = evaluateInboundStopPreflight(f);
      expect(r.blockers).toEqual(["inbound_reaches"]);
      expect(r.checks.find((c) => c.id === "inbound_reaches")?.detail).toMatch(/connection overrides/);
    });

    it("an override does not rescue a wrong URL", () => {
      const f = allProven();
      f.service!.inboundRequestUrl = "https://www.hone.example/api/twilio/inbound-sms#rp=5xx";
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["inbound_reaches"]);
    });

    it("the number's own URL and every pool number's URL may carry overrides too", () => {
      const f = allProven();
      Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null });
      f.routedFromNumber = undefined;
      f.service!.senderPool = [
        { phoneNumber: "+14165550100", smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: null },
        { phoneNumber: "+14165550101", smsUrl: `${URL_OK}#ct=500&rt=2000&rp=all&e=dublin,sydney`, smsMethod: "POST", smsApplicationSid: null },
      ];
      expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
      f.service!.senderPool[1].smsUrl = `${URL_OK}#bogus=1`;
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["sender_pool"]);
    });
  });

  describe("STOP REDELIVERY: a STOP the route answers 500 must be retried (Codex P1 4254444665)", () => {
    const redelivery = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery");

    for (const frag of [
      FULL_RETRY,
      "#ct=1000&rt=5000&rp=all&e=ashburn,umatilla",
      // Twilio's own "example with all overrides": 2 * (500 + 1000) <= 15000.
      "#ct=500&rt=1000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&sni=y&e=dublin,sydney",
    ]) {
      it(`${frag}: every delivery failure is retried within the budget`, () => {
        const f = allProven();
        f.service!.inboundRequestUrl = `${URL_OK}${frag}`;
        expect(redelivery(f)?.status).toBe("pass");
      });
    }

    for (const [why, frag] of [
      ["no fragment (Twilio's default retries connect failures only)", ""],
      ["rp without 5xx", "#rp=4xx,ct,rt"],
      ["rp=5xx but rc=0", "#rp=5xx&rc=0"],
      ["timeouts only", "#ct=1000&rt=5000"],
      // Codex P1 4264761390: naming rp REPLACES the default ct, so 5xx alone
      // leaves connect/TLS failures and read timeouts unretried.
      ["rp=5xx alone (connect failures and read timeouts unretried)", "#ct=1000&rt=5000&rp=5xx"],
      ["rp=5xx,ct (read timeouts unretried)", "#ct=1000&rt=5000&rp=5xx,ct"],
      ["rp=5xx,rt (connect failures unretried)", "#ct=1000&rt=5000&rp=5xx,rt"],
      ["rp=4xx,5xx", "#rc=1&ct=1000&rt=5000&rp=4xx,5xx"],
      // Every failure named, but the default ct/rt (5000 + 15000) twice exceed tt 15000.
      ["rp=all with default timeouts (no room for the retry)", "#rp=all"],
      ["rp=ct,rt,5xx with default timeouts", "#rp=ct,rt,5xx&rc=3"],
      ["the bare 5xx override", "#rp=5xx"],
    ] as const) {
      it(`${why}: blocked (unknown with no fallback read)`, () => {
        const f = allProven();
        f.service!.inboundRequestUrl = `${URL_OK}${frag}`;
        const r = evaluateInboundStopPreflight(f);
        expect(r.blockers).toEqual(["stop_redelivery"]);
        expect(redelivery(f)?.status).toBe("unknown");
      });
    }

    describe("TOTAL TIME: the budget must hold a worst-case attempt AND one full retry, tt >= 2 * (ct + rt) (Codex P1s 4254745407, 4264761390)", () => {
      for (const frag of [
        "#tt=100&rp=all&ct=100&rt=100",
        "#tt=11999&rp=all&ct=1000&rt=5000",
        "#tt=14999&rp=all&rc=3",
        "#ct=5000&rt=5000&rp=all",
      ]) {
        it(`${frag}: not certified`, () => {
          expect(retriesRecoverDelivery(`${URL_OK}${frag}`)).toBe(false);
        });
      }
      for (const frag of [
        "#tt=12000&rp=all&ct=1000&rt=5000&e=ashburn,umatilla",
        FULL_RETRY,
        "#ct=2500&rt=5000&rp=4xx,ct,rt,5xx&e=ashburn,umatilla",
        "#ct=500&rt=1000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&sni=y&e=dublin,sydney",
      ]) {
        it(`${frag}: certified`, () => {
          expect(retriesRecoverDelivery(`${URL_OK}${frag}`)).toBe(true);
        });
      }

      const ruleSetting = (totalTimeoutMs: number | null | undefined) => ({
        matched: true as const,
        settings: [
          { settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY, totalTimeoutMs },
        ],
      });

      it("a Rule Setting's totalTimeoutMs: omitted or >= 15000 retries; below, not; unreported, unknown", () => {
        const f = allProven();
        Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
        f.webhookRules = ruleSetting(undefined);
        expect(redelivery(f)?.status).toBe("pass");
        f.webhookRules = ruleSetting(60000);
        expect(redelivery(f)?.status).toBe("pass");
        f.webhookRules = ruleSetting(5000);
        expect(redelivery(f)?.status).toBe("fail");
        f.webhookRules = ruleSetting(null);
        expect(redelivery(f)?.status).toBe("unknown");
      });
    });

    it("retriesRecoverDelivery never trusts an invalid fragment, even one naming rp=5xx", () => {
      expect(retriesRecoverDelivery(URL_RETRY)).toBe(true);
      expect(retriesRecoverDelivery(`${URL_RETRY}&sni=on`)).toBe(false);
      expect(retriesRecoverDelivery(`${URL_RETRY}&rp=all`)).toBe(false);
      expect(retriesRecoverDelivery(URL_OK)).toBe(false);
      expect(retriesRecoverDelivery(null)).toBe(false);
    });

    describe("account Webhook Rules take precedence and decide signing (Codex P1s 4254537039, 4254655904; P2 4254655911)", () => {
      type Setting = {
        settingType?: "SYSTEM" | "CUSTOMER" | null; percentage: number | null;
        authScheme: string | null;
        signatureType: string | null;
        signatureAlgorithm: string | null;
        retryOn: string[] | null;
        retryCount: number | null;
        connectTimeoutMs?: number | null;
        readTimeoutMs?: number | null;
        edgeZones: "omitted" | { zones: readonly string[]; allowZoneFallback?: boolean | null } | null;
      };
      const setting = (over: Partial<Setting> = {}): Setting => ({
        settingType: "CUSTOMER" as const, percentage: 100,
        authScheme: "NONE",
        signatureType: "ACCOUNT_AUTH_TOKEN",
        signatureAlgorithm: "HMAC_SHA1",
        ...SETTING_RECOVERY,
        ...over,
      });
      const rulesCheck = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "webhook_rules");

      it("rules unread: blocked, and #rp=5xx alone is not trusted", () => {
        const f = allProven();
        f.webhookRules = undefined;
        expect(evaluateInboundStopPreflight(f).blockers).toEqual(["webhook_rules", "stop_redelivery"]);
      });

      it("a matching Rule whose Setting is ACCOUNT_AUTH_TOKEN + HMAC_SHA1 and retries HTTP_5XX: ready even without a fragment", () => {
        const f = allProven();
        f.service!.inboundRequestUrl = URL_OK;
        f.webhookRules = { matched: true, settings: [setting()] };
        expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
      });

      it("retryOn ALL also redelivers", () => {
        const f = allProven();
        f.webhookRules = { matched: true, settings: [setting({ retryOn: ["ALL"] })] };
        expect(redelivery(f)?.status).toBe("pass");
      });

      for (const [why, over] of [
        ["signature NONE", { signatureType: "NONE", signatureAlgorithm: null }],
        ["a SHARED_KEY", { signatureType: "SHARED_KEY", signatureAlgorithm: "HMAC_SHA1" }],
        ["the account token by HMAC_SHA256", { signatureAlgorithm: "HMAC_SHA256" }],
      ] as const) {
        it(`a Setting signing with ${why}: every STOP would be refused`, () => {
          const f = allProven();
          f.webhookRules = { matched: true, settings: [setting(over)] };
          expect(rulesCheck(f)?.status).toBe("fail");
        });
      }

      it("a Setting's signing unreported: unknown", () => {
        const f = allProven();
        f.webhookRules = { matched: true, settings: [setting({ signatureAlgorithm: null })] };
        expect(rulesCheck(f)?.status).toBe("unknown");
      });

      it("a matching Rule that does NOT retry 5xx overrides the URL's #rp=5xx", () => {
        const f = allProven();
        f.webhookRules = { matched: true, settings: [setting({ retryOn: ["CONNECTION_TIMEOUT"] })] };
        expect(redelivery(f)?.status).toBe("unknown"); // fallback unread
        Object.assign(f.service!, { fallbackUrl: "https://elsewhere.example/sms", fallbackMethod: "POST" });
        expect(redelivery(f)?.status).toBe("fail");
      });

      it("HTTP_5XX with retryCount 0 does not redeliver", () => {
        const f = allProven();
        Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
        f.webhookRules = { matched: true, settings: [setting({ retryOn: ["HTTP_5XX"], retryCount: 0 })] };
        expect(redelivery(f)?.status).toBe("fail");
      });

      it("an omitted retryPolicy (no retries: [] and 0) does not redeliver", () => {
        const f = allProven();
        Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
        f.webhookRules = { matched: true, settings: [setting({ retryOn: [], retryCount: 0 })] };
        expect(redelivery(f)?.status).toBe("fail");
      });

      it("a live traffic split: EVERY Setting with traffic must sign correctly and retry 5xx", () => {
        const f = allProven();
        Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
        f.webhookRules = { matched: true, settings: [setting({ settingType: "CUSTOMER" as const, percentage: 70 }), setting({ settingType: "CUSTOMER" as const, percentage: 30, retryOn: ["HTTP_4XX"] })] };
        expect(redelivery(f)?.status).toBe("fail");
        f.webhookRules = { matched: true, settings: [setting({ settingType: "CUSTOMER" as const, percentage: 70 }), setting({ settingType: "CUSTOMER" as const, percentage: 30, signatureType: "NONE" })] };
        expect(rulesCheck(f)?.status).toBe("fail");
      });

      it("a 0/100 rollout: the zero-share Setting never receives traffic and is ignored", () => {
        const f = allProven();
        f.service!.inboundRequestUrl = URL_OK;
        f.webhookRules = {
          matched: true,
          settings: [
            setting({ settingType: "CUSTOMER" as const, percentage: 0, signatureType: "SHARED_KEY", retryOn: [], retryCount: 0 }),
            setting({ settingType: "CUSTOMER" as const, percentage: 100 }),
          ],
        };
        expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
      });

      it("shares not reported: unknown, never assumed", () => {
        const f = allProven();
        f.webhookRules = { matched: true, settings: [setting({ settingType: "CUSTOMER" as const, percentage: null })] };
        expect(rulesCheck(f)?.status).toBe("unknown");
        expect(redelivery(f)?.status).toBe("unknown");
      });

      it("a matching Rule with no Settings listed proves nothing", () => {
        const f = allProven();
        f.webhookRules = { matched: true, settings: [] };
        expect(rulesCheck(f)?.status).toBe("unknown");
      });
    });

    describe("each unpinned pool number may redeliver by its OWN fallback (Codex P2 4254655918)", () => {
      const poolRoute = () => {
        const f = allProven();
        Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null });
        f.routedFromNumber = undefined;
        return f;
      };

      it("plain primary URLs, each with its own same-route POST fallback: ready", () => {
        const f = poolRoute();
        f.service!.senderPool = [
          { phoneNumber: "+14165550100", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_EDGES, smsFallbackMethod: "POST" },
          { phoneNumber: "+14165550101", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_EDGES, smsFallbackMethod: "POST" },
        ];
        expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")?.status).toBe("pass");
      });

      it("one member with neither a 5xx retry nor its own fallback: blocked", () => {
        const f = poolRoute();
        f.service!.senderPool = [
          { phoneNumber: "+14165550100", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_EDGES, smsFallbackMethod: "POST" },
          { phoneNumber: "+14165550101", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: null, smsFallbackMethod: null },
        ];
        expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")?.status).toBe("fail");
      });
    });

    describe("PROPAGATION: a new Rule or Setting is not trusted until it has reached the delivery plane (Codex P1 4259214614)", () => {
      const prop = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "webhook_propagation");
      for (const [why, p, detail] of [
        ["an Operation PENDING", { ruleOperationStatuses: ["COMPLETED", "PENDING"], secondsSinceLastConfigChange: 3600 }, /still propagating/],
        ["an Operation RUNNING", { ruleOperationStatuses: ["RUNNING"], secondsSinceLastConfigChange: 3600 }, /still propagating/],
        ["a change 30 s ago", { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 30 }, /still propagating/],
        ["a Setting changed 30 s ago, no Rule written", { ruleOperationStatuses: [], secondsSinceLastConfigChange: 30 }, /still propagating/],
        ["Operations not read", { ruleOperationStatuses: null, secondsSinceLastConfigChange: 3600 }, /not read/],
        ["the last change time not read", { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: null }, /not read/],
        ["an unrecognised status", { ruleOperationStatuses: ["QUEUED"], secondsSinceLastConfigChange: 3600 }, /unrecognised/],
      ] as const) {
        it(`${why}: blocked as unknown ("wait"), never a misconfiguration`, () => {
          const f = allProven();
          f.webhookPropagation = { ...p };
          const r = evaluateInboundStopPreflight(f);
          expect(r.blockers).toEqual(["webhook_propagation"]);
          expect(prop(f)?.status).toBe("unknown");
          expect(prop(f)?.detail).toMatch(detail);
        });
      }

      it("exactly 90 s and COMPLETED: settled (FAQ: 30 to 90 s)", () => {
        const f = allProven();
        f.webhookPropagation = { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 90 };
        expect(prop(f)?.status).toBe("pass");
      });

      for (const secs of [60, 89]) {
        it(`${secs} s after a change, even COMPLETED: still within the documented 90 s, unknown, never ready`, () => {
          const f = allProven();
          f.webhookPropagation = { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: secs };
          expect(prop(f)?.status).toBe("unknown");
          expect(evaluateInboundStopPreflight(f).ready).toBe(false);
        });
      }

      it("no Rule written and settled for 90 s: settled", () => {
        const f = allProven();
        f.webhookPropagation = { ruleOperationStatuses: [], secondsSinceLastConfigChange: 90 };
        expect(prop(f)?.status).toBe("pass");
      });

      for (const st of ["FAILED", "CANCELLED"]) {
        it(`a ${st} Operation is a FAILURE, not a wait, even long after the change (Codex P2 4259396130)`, () => {
          const f = allProven();
          f.webhookPropagation = { ruleOperationStatuses: ["COMPLETED", st], secondsSinceLastConfigChange: 86400 };
          const r = evaluateInboundStopPreflight(f);
          expect(r.blockers).toEqual(["webhook_propagation"]);
          expect(prop(f)?.status).toBe("fail");
          expect(prop(f)?.detail).toMatch(new RegExp(`ended ${st}.*re-apply`));
        });
      }

      it("a terminal Operation fails even when the change time was not read", () => {
        const f = allProven();
        f.webhookPropagation = { ruleOperationStatuses: ["FAILED"], secondsSinceLastConfigChange: null };
        expect(prop(f)?.status).toBe("fail");
      });

      it("propagation facts absent: unknown", () => {
        const f = allProven();
        f.webhookPropagation = undefined;
        expect(prop(f)?.status).toBe("unknown");
      });

      it("Rules unread: propagation is not reported separately (webhook_rules already blocks)", () => {
        const f = allProven();
        f.webhookRules = undefined;
        expect(prop(f)).toBeUndefined();
      });
    });

    describe("under the number override, only the NUMBER's fallback counts (Codex P1 4254537025)", () => {
      const numberRoute = () => {
        const f = allProven();
        Object.assign(f.service!, {
          useInboundWebhookOnNumber: true,
          numberSmsUrl: URL_OK, // no 5xx retry on the number's own URL
          numberSmsMethod: "POST",
          numberSmsApplicationSid: null,
          fallbackUrl: URL_EDGES, // the SERVICE fallback: ignored on this path
          fallbackMethod: "POST",
        });
        return f;
      };

      it("a service fallback to Hone does not redeliver a number-routed STOP", () => {
        const f = numberRoute();
        expect(redelivery(f)?.status).toBe("unknown"); // number fallback unread
        Object.assign(f.service!, { numberSmsFallbackUrl: null, numberSmsFallbackMethod: null });
        expect(redelivery(f)?.status).toBe("fail");
      });

      it("the number's own fallback to the same route by POST does", () => {
        const f = numberRoute();
        Object.assign(f.service!, { numberSmsFallbackUrl: URL_EDGES, numberSmsFallbackMethod: "POST" });
        expect(redelivery(f)?.status).toBe("pass");
        expect(redelivery(f)?.detail).toMatch(/number's sms_fallback_url/);
      });

      it("the number's fallback by GET, or elsewhere, does not", () => {
        const f = numberRoute();
        Object.assign(f.service!, { numberSmsFallbackUrl: URL_EDGES, numberSmsFallbackMethod: "GET" });
        expect(redelivery(f)?.status).toBe("fail");
        Object.assign(f.service!, { numberSmsFallbackUrl: "https://elsewhere.example/sms", numberSmsFallbackMethod: "POST" });
        expect(redelivery(f)?.status).toBe("fail");
      });
    });

    it("a plain URL with a fallback to the SAME route by POST: redelivered", () => {
      const f = allProven();
      Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: URL_EDGES, fallbackMethod: "POST" });
      expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
    });

    it("a fallback that IS the route but whose method was not read: unknown, never misconfigured", () => {
      const f = allProven();
      Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: URL_EDGES, fallbackMethod: undefined });
      expect(redelivery(f)?.status).toBe("unknown");
    });

    it("a pool member whose same-route fallback method was not read: unknown", () => {
      const f = allProven();
      Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null });
      f.routedFromNumber = undefined;
      f.service!.senderPool = [
        { phoneNumber: "+14165550100", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_EDGES },
      ];
      expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")?.status).toBe("unknown");
    });

    for (const [why, fb] of [
      ["another URL", { fallbackUrl: "https://elsewhere.example/sms", fallbackMethod: "POST" }],
      ["GET", { fallbackUrl: URL_EDGES, fallbackMethod: "GET" }],
      ["none (null)", { fallbackUrl: null, fallbackMethod: null }],
    ] as const) {
      it(`a plain URL with a fallback that is ${why}: fails`, () => {
        const f = allProven();
        Object.assign(f.service!, { inboundRequestUrl: URL_OK, ...fb });
        expect(redelivery(f)?.status).toBe("fail");
      });
    }

    it("the number's own URL is the one that must redeliver when it overrides", () => {
      const f = allProven();
      Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_OK, numberSmsMethod: "POST", numberSmsApplicationSid: null, inboundRequestUrl: URL_RETRY });
      expect(redelivery(f)?.status).toBe("unknown");
      f.service!.numberSmsUrl = URL_RETRY;
      expect(redelivery(f)?.status).toBe("pass");
    });

    it("a wrong URL is reported once, by inbound_reaches, not again here", () => {
      const f = allProven();
      f.service!.inboundRequestUrl = "https://www.hone.example/api/twilio/inbound-sms";
      expect(redelivery(f)).toBeUndefined();
    });

    it("every pool number must redeliver too, when the pool is what proves reach", () => {
      const f = allProven();
      Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null });
      f.routedFromNumber = undefined;
      f.service!.senderPool = [
        { phoneNumber: "+14165550100", smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: null },
        { phoneNumber: "+14165550101", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null },
      ];
      // The member's fallback was not read: UNKNOWN, never reported as lost (Codex P2 4254745411).
      const c = evaluateInboundStopPreflight(f).checks.find((x) => x.id === "sender_pool");
      expect(c?.status).toBe("unknown");
      expect(c?.detail).toMatch(/not proven/);
    });
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

describe("the base URL is used RAW, exactly as the route verifies (Codex P2 4251745257)", () => {
  for (const base of ["https://hone.example:443", "https://Hone.Example"]) {
    it(`${base}: the expected URL keeps the base verbatim, and the configured URL agrees`, () => {
      const url = `${base}/api/twilio/inbound-sms`;
      expect(expectedInboundWebhookUrl({ TWILIO_WEBHOOK_BASE_URL: base })).toEqual({ ok: true, url });
      const f = allProven();
      f.env = { ...f.env, TWILIO_WEBHOOK_BASE_URL: base };
      f.service!.inboundRequestUrl = `${url}${FULL_RETRY}`;
      const r = evaluateInboundStopPreflight(f);
      expect(r.blockers).toEqual([]);
    });

    it(`${base}: a service naming the normalised origin instead is refused`, () => {
      const f = allProven();
      f.env = { ...f.env, TWILIO_WEBHOOK_BASE_URL: base };
      f.service!.inboundRequestUrl = `${URL_OK}#rp=5xx`;
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["inbound_reaches"]);
    });
  }
});

describe("signing proof must postdate the CURRENT token and base (Codex P1 4251931839)", () => {
  const sign = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "signing_proven");
  for (const [why, proof] of [
    ["callbacks only before a token rotation", { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: "2026-10-12T11:00:00Z" }],
    ["the newest callback at the very instant of the change", { lastVerifiedCallbackAt: "2026-10-12T11:00:00Z", credentialsActiveSince: "2026-10-12T11:00:00Z" }],
    ["the activation time not read", { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: null }],
    ["an unparseable activation time", { lastVerifiedCallbackAt: "2026-10-12T10:00:00Z", credentialsActiveSince: "yesterday" }],
    ["no callback observed", { lastVerifiedCallbackAt: null, credentialsActiveSince: "2026-10-12T11:00:00Z" }],
  ] as const) {
    it(`${why}: unknown, a blocker`, () => {
      const f = allProven();
      f.signatureProof = { ...proof };
      expect(sign(f)?.status).toBe("unknown");
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["signing_proven"]);
    });
  }

  it("a callback one second after the current credentials went live: proven", () => {
    const f = allProven();
    f.signatureProof = { lastVerifiedCallbackAt: "2026-10-12T11:00:01Z", credentialsActiveSince: "2026-10-12T11:00:00Z" };
    expect(sign(f)?.status).toBe("pass");
  });

  it("no proof gathered: unknown", () => {
    const f = allProven();
    f.signatureProof = undefined;
    expect(sign(f)?.status).toBe("unknown");
  });
});

describe("stop_forwarded requires OBSERVED suppression, not mere forwarding (Codex P1 4251745248)", () => {
  const stop = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_forwarded");
  for (const [why, obs, status] of [
    ["forwarded but rejected 403 (signature)", { reachedRoute: true, routeStatus: 403, phoneWideOptOutStamped: null }, "fail"],
    ["forwarded but the route errored 500", { reachedRoute: true, routeStatus: 500, phoneWideOptOutStamped: false }, "fail"],
    ["accepted 200 but nothing stamped", { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: false }, "fail"],
    ["consumed by the service", { reachedRoute: false, routeStatus: null, phoneWideOptOutStamped: null }, "fail"],
    ["forwarded, status not read", { reachedRoute: true, routeStatus: null, phoneWideOptOutStamped: true }, "unknown"],
    ["accepted 200, stamp not read", { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: null }, "unknown"],
    ["delivery not read", { reachedRoute: null, routeStatus: 200, phoneWideOptOutStamped: true }, "unknown"],
  ] as const) {
    it(`${why}: ${status}, a blocker`, () => {
      const f = allProven();
      f.liveStopObservation = { ...obs };
      expect(stop(f)?.status).toBe(status);
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["stop_forwarded"]);
    });
  }

  it("not yet observed: unknown", () => {
    const f = allProven();
    f.liveStopObservation = undefined;
    expect(stop(f)?.status).toBe("unknown");
  });
});

describe("a matching Setting must authenticate with scheme NONE (Codex P1 4264160015)", () => {
  type MatchedSetting = Extract<NonNullable<InboundStopFacts["webhookRules"]>, { matched: true }>["settings"][number];
  const setting = (over: Partial<MatchedSetting> = {}): MatchedSetting => ({
    settingType: "CUSTOMER" as const, percentage: 100,
    authScheme: "NONE",
    signatureType: "ACCOUNT_AUTH_TOKEN",
    signatureAlgorithm: "HMAC_SHA1",
    ...SETTING_RECOVERY,
    ...over,
  });
  const withRule = (...settings: MatchedSetting[]): InboundStopFacts => {
    const f = allProven();
    f.webhookRules = { matched: true, settings };
    return f;
  };
  const rulesCheck = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "webhook_rules");

  it("NONE with account-token HMAC-SHA1 signing and 5xx retries: ready through every gate", () => {
    const r = evaluateInboundStopPreflight(withRule(setting()));
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
  });

  for (const scheme of ["OAUTH2", "BASIC", "DIGEST"]) {
    it(`${scheme}: refused even though its signature and retry fields are perfect`, () => {
      const f = withRule(setting({ authScheme: scheme }));
      expect(rulesCheck(f)?.status).toBe("fail");
      expect(rulesCheck(f)?.detail).toMatch(/OAUTH2, BASIC or DIGEST/);
      expect(evaluateInboundStopPreflight(f).ready).toBe(false);
    });
  }

  for (const [why, scheme] of [
    ["not read (an unread AuthProfile)", null],
    ["unrecognised", "BEARER"],
    ["lower-case, not Twilio's enum", "none"],
  ] as const) {
    it(`auth scheme ${why}: unknown, never a pass from the signature and retry fields alone`, () => {
      const f = withRule(setting({ authScheme: scheme }));
      expect(rulesCheck(f)?.status).toBe("unknown");
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["webhook_rules"]);
    });
  }

  it("a 30% OAUTH2 share beside a 70% NONE share: refused", () => {
    expect(rulesCheck(withRule(setting({ settingType: "CUSTOMER" as const, percentage: 70 }), setting({ settingType: "CUSTOMER" as const, percentage: 30, authScheme: "OAUTH2" })))?.status).toBe("fail");
  });

  it("an OAUTH2 Setting with a 0% share receives no traffic: not counted", () => {
    expect(rulesCheck(withRule(setting({ settingType: "CUSTOMER" as const, percentage: 100 }), setting({ settingType: "CUSTOMER" as const, percentage: 0, authScheme: "OAUTH2" })))?.status).toBe("pass");
  });

  it("an unsupported scheme is reported as such even when the signing is also wrong", () => {
    expect(rulesCheck(withRule(setting({ authScheme: "OAUTH2", signatureType: "SHARED_KEY" })))?.detail).toMatch(/OAUTH2, BASIC or DIGEST/);
  });

  it("SETTINGS DRIFT: facts that were ready stop being ready once the Setting moves to OAUTH2, and the change itself must settle", () => {
    const before = withRule(setting());
    expect(evaluateInboundStopPreflight(before).ready).toBe(true);
    const after = withRule(setting({ authScheme: "OAUTH2" }));
    after.webhookPropagation = { ruleOperationStatuses: [], secondsSinceLastConfigChange: 10 };
    const r = evaluateInboundStopPreflight(after);
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(expect.arrayContaining(["webhook_rules", "webhook_propagation"]));
    // Moving back to NONE is trusted only after the change has propagated.
    const back = withRule(setting());
    back.webhookPropagation = { ruleOperationStatuses: [], secondsSinceLastConfigChange: 10 };
    expect(evaluateInboundStopPreflight(back).blockers).toEqual(["webhook_propagation"]);
  });
});

type LiveSetting = Extract<NonNullable<InboundStopFacts["webhookRules"]>, { matched: true }>["settings"][number];
const liveSetting = (over: Partial<LiveSetting> = {}): LiveSetting => ({
  settingType: "CUSTOMER" as const, percentage: 100,
  authScheme: "NONE",
  signatureType: "ACCOUNT_AUTH_TOKEN",
  signatureAlgorithm: "HMAC_SHA1",
  ...SETTING_RECOVERY,
  ...over,
});
const underRule = (...settings: LiveSetting[]): InboundStopFacts => {
  const f = allProven();
  // No fallback, so only the retries can recover a failed delivery.
  Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
  f.webhookRules = { matched: true, settings };
  return f;
};
const checkOf = (f: InboundStopFacts, id: string) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === id);

describe("a live Setting's retries must recover EVERY delivery failure (Codex P1 4264761390)", () => {
  it("POSITIVE CONTROL: 5xx, connect and read-timeout retries within budget: ready through every gate", () => {
    const r = evaluateInboundStopPreflight(underRule(liveSetting()));
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it("POSITIVE CONTROL: Twilio's documented example (5000 / 10000 / 30000, three retries on all three) recovers", () => {
    const f = underRule(liveSetting({ connectTimeoutMs: 5000, readTimeoutMs: 10000, totalTimeoutMs: 30000, retryCount: 3 }));
    expect(checkOf(f, "stop_redelivery")?.status).toBe("pass");
  });

  it("ALL covers all three", () => {
    expect(checkOf(underRule(liveSetting({ retryOn: ["ALL"] })), "stop_redelivery")?.status).toBe("pass");
  });

  for (const [why, retryOn] of [
    ["HTTP_5XX only", ["HTTP_5XX"]],
    ["HTTP_5XX and CONNECTION_TIMEOUT (read timeouts lost)", ["HTTP_5XX", "CONNECTION_TIMEOUT"]],
    ["HTTP_5XX and READ_TIMEOUT (connect/TLS failures lost)", ["HTTP_5XX", "READ_TIMEOUT"]],
    ["the timeouts only (a 5xx lost)", ["CONNECTION_TIMEOUT", "READ_TIMEOUT"]],
    ["HTTP_4XX and HTTP_5XX", ["HTTP_4XX", "HTTP_5XX"]],
  ] as const) {
    it(`${why}: refused`, () => {
      const f = underRule(liveSetting({ retryOn: [...retryOn] }));
      expect(checkOf(f, "stop_redelivery")?.status).toBe("fail");
      expect(checkOf(f, "stop_redelivery")?.detail).toMatch(/connect\/TLS, read timeout, a transient 4xx or 5xx/);
    });
  }

  it("connection omitted (5000 + 15000) with the assumed 15000 total: no room for a retry, refused; a 40000 total recovers", () => {
    const omitted = liveSetting({ connectTimeoutMs: undefined, readTimeoutMs: undefined, totalTimeoutMs: undefined });
    expect(checkOf(underRule(omitted), "stop_redelivery")?.status).toBe("fail");
    expect(checkOf(underRule({ ...omitted, totalTimeoutMs: 40000 }), "stop_redelivery")?.status).toBe("pass");
    expect(checkOf(underRule({ ...omitted, totalTimeoutMs: 39999 }), "stop_redelivery")?.status).toBe("fail");
  });

  for (const field of ["connectTimeoutMs", "readTimeoutMs", "totalTimeoutMs", "retryOn", "retryCount"] as const) {
    it(`${field} not read: unknown`, () => {
      expect(checkOf(underRule(liveSetting({ [field]: null })), "stop_redelivery")?.status).toBe("unknown");
    });
  }

  it("every failure named and within budget, but ZERO retries: nothing is retried, refused (URL and Setting)", () => {
    expect(retriesRecoverDelivery(`${URL_OK}#ct=1000&rt=5000&rc=0&rp=all`)).toBe(false);
    expect(retriesRecoverDelivery(`${URL_OK}#ct=1000&rt=5000&rc=1&rp=all&e=ashburn,umatilla`)).toBe(true);
    expect(checkOf(underRule(liveSetting({ retryCount: 0 })), "stop_redelivery")?.status).toBe("fail");
  });

  it("an unrecognised retryOn value counts for nothing", () => {
    expect(checkOf(underRule(liveSetting({ retryOn: ["HTTP_5XX", "CONNECTION_TIMEOUT", "READ_TIMEOUTS"] })), "stop_redelivery")?.status).toBe("fail");
  });

  it("PRECEDENCE: the Setting decides, not the URL — a complete URL override under a 5xx-only Setting is refused", () => {
    const f = underRule(liveSetting({ retryOn: ["HTTP_5XX"] }));
    f.service!.inboundRequestUrl = URL_RETRY;
    expect(checkOf(f, "stop_redelivery")?.status).toBe("fail");
  });

  it("PRECEDENCE: a 5xx-only URL override under a complete Setting recovers", () => {
    const f = underRule(liveSetting());
    f.service!.inboundRequestUrl = `${URL_OK}#rp=5xx`;
    expect(checkOf(f, "stop_redelivery")?.status).toBe("pass");
  });

  it("SPLIT: every non-zero share must recover; a zero share is ignored", () => {
    expect(checkOf(underRule(liveSetting({ settingType: "CUSTOMER" as const, percentage: 70 }), liveSetting({ settingType: "CUSTOMER" as const, percentage: 30, retryOn: ["HTTP_5XX"] })), "stop_redelivery")?.status).toBe("fail");
    expect(checkOf(underRule(liveSetting({ settingType: "CUSTOMER" as const, percentage: 100 }), liveSetting({ settingType: "CUSTOMER" as const, percentage: 0, retryOn: ["HTTP_5XX"] })), "stop_redelivery")?.status).toBe("pass");
  });

  it("under a Rule the fallback runs on the SAME Setting: a non-recovering Setting is not rescued by it (Codex P1 4269949178)", () => {
    const f = underRule(liveSetting({ retryOn: ["HTTP_5XX"] }));
    Object.assign(f.service!, { fallbackUrl: URL_EDGES, fallbackMethod: "POST" });
    expect(checkOf(f, "stop_redelivery")?.status).toBe("fail");
    expect(evaluateInboundStopPreflight(f).ready).toBe(false);
  });

  it("with no Rule, a fallback that recovers its own failures does rescue a non-recovering primary", () => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: `${URL_OK}#ct=1000&rt=5000&rp=5xx&e=ashburn,umatilla`, fallbackUrl: URL_EDGES, fallbackMethod: "POST" });
    expect(checkOf(f, "stop_redelivery")?.status).toBe("pass");
    expect(checkOf(f, "stop_redelivery")?.detail).toMatch(/same route, by POST/);
  });

  it("the other gates still bind: a complete retry policy does not rescue SHARED_KEY signing or OAUTH2 auth", () => {
    expect(evaluateInboundStopPreflight(underRule(liveSetting({ signatureType: "SHARED_KEY" }))).ready).toBe(false);
    expect(evaluateInboundStopPreflight(underRule(liveSetting({ authScheme: "OAUTH2" }))).ready).toBe(false);
  });
});

describe("a live Setting's edge zones must not drop a STOP on one zone's outage (Codex P2 4264761398)", () => {
  const CATALOG = [
    { id: "zone-a", activeEdgeLocations: 2 },
    { id: "zone-b", activeEdgeLocations: 1 },
    { id: "zone-empty", activeEdgeLocations: 0 },
  ];
  const zoned = (edgeZones: LiveSetting["edgeZones"], catalog: InboundStopFacts["edgeZoneCatalog"] = CATALOG) => {
    const f = underRule(liveSetting({ edgeZones }));
    f.edgeZoneCatalog = catalog;
    return f;
  };
  const zones = (f: InboundStopFacts) => checkOf(f, "webhook_zones")?.status;

  it("edgeZones observed omitted: every zone eligible, ready", () => {
    const f = zoned("omitted");
    f.edgeZoneCatalog = undefined; // not needed when every zone is eligible
    expect(zones(f)).toBe("pass");
    expect(evaluateInboundStopPreflight(f).ready).toBe(true);
  });

  it("ONE zone, allowZoneFallback false: refused, and the decision is left to the owner", () => {
    const f = zoned({ zones: ["zone-a"], allowZoneFallback: false });
    expect(zones(f)).toBe("fail");
    expect(checkOf(f, "webhook_zones")?.detail).toMatch(/data residency.*owner decision/);
    expect(evaluateInboundStopPreflight(f).blockers).toEqual(["webhook_zones"]);
  });

  it("ONE zone, allowZoneFallback omitted: the documented default is FALSE, refused (not unknown)", () => {
    expect(zones(zoned({ zones: ["zone-a"] }))).toBe("fail");
  });

  it("ONE zone with fallback enabled: ready", () => {
    expect(zones(zoned({ zones: ["zone-a"], allowZoneFallback: true }))).toBe("pass");
  });

  it("an uncatalogued zone with fallback enabled still delivers: ready", () => {
    expect(zones(zoned({ zones: ["zone-gone"], allowZoneFallback: true }))).toBe("pass");
  });

  it("REDUNDANCY: two catalogued zones with active edge locations, no fallback: ready", () => {
    expect(zones(zoned({ zones: ["zone-a", "zone-b"], allowZoneFallback: false }))).toBe("pass");
  });

  for (const [why, list] of [
    ["the second zone has no active edge location", ["zone-a", "zone-empty"]],
    ["the second zone is not in the current catalog", ["zone-a", "zone-gone"]],
  ] as const) {
    it(`two zones, but ${why}: effectively one zone, refused`, () => {
      expect(zones(zoned({ zones: [...list], allowZoneFallback: false }))).toBe("fail");
    });
  }

  it("two zones without fallback and the catalog unread: unknown", () => {
    const f = zoned({ zones: ["zone-a", "zone-b"] });
    f.edgeZoneCatalog = undefined;
    expect(zones(f)).toBe("unknown");
  });

  for (const [why, edgeZones] of [
    ["edgeZones not read", null],
    ["allowZoneFallback not read", { zones: ["zone-a", "zone-b"], allowZoneFallback: null }],
    ["an empty zone list", { zones: [] }],
    ["a duplicated zone", { zones: ["zone-a", "zone-a"] }],
    ["a non-string zone", { zones: [7] as unknown as string[] }],
    ["zones missing", {} as unknown as { zones: string[] }],
    ["a non-boolean allowZoneFallback", { zones: ["zone-a"], allowZoneFallback: "yes" as unknown as boolean }],
  ] as const) {
    it(`${why}: unknown, never assumed`, () => {
      const f = zoned(edgeZones as LiveSetting["edgeZones"]);
      expect(zones(f)).toBe("unknown");
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["webhook_zones"]);
    });
  }

  it("SPLIT: a 30% single-zone share without fallback is refused; at 0% it is ignored", () => {
    const f = underRule(liveSetting({ settingType: "CUSTOMER" as const, percentage: 70 }), liveSetting({ settingType: "CUSTOMER" as const, percentage: 30, edgeZones: { zones: ["zone-a"] } }));
    f.edgeZoneCatalog = CATALOG;
    expect(zones(f)).toBe("fail");
    const g = underRule(liveSetting({ settingType: "CUSTOMER" as const, percentage: 100 }), liveSetting({ settingType: "CUSTOMER" as const, percentage: 0, edgeZones: { zones: ["zone-a"] } }));
    expect(zones(g)).toBe("pass");
  });

  it("DRIFT: a ready Setting narrowed to one zone stops being ready, and widening it back must propagate first", () => {
    expect(evaluateInboundStopPreflight(zoned("omitted")).ready).toBe(true);
    const narrowed = zoned({ zones: ["zone-a"] });
    narrowed.webhookPropagation = { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 5 };
    expect(evaluateInboundStopPreflight(narrowed).blockers).toEqual(["webhook_zones", "webhook_propagation"]);
    const widened = zoned({ zones: ["zone-a", "zone-b"] });
    widened.webhookPropagation = { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 5 };
    expect(evaluateInboundStopPreflight(widened).blockers).toEqual(["webhook_propagation"]);
  });

  it("no Rule matches: no Settings, so no zone check (the URL's own e= override is not a Setting)", () => {
    expect(checkOf(allProven(), "webhook_zones")).toBeUndefined();
  });

  it("Rules unread: no separate zone check (webhook_rules already blocks)", () => {
    const f = allProven();
    f.webhookRules = undefined;
    expect(checkOf(f, "webhook_zones")).toBeUndefined();
  });
});

describe("URL overrides that defeat their own retries (Codex P1 4265363596, P2 4265363603)", () => {
  const noFallback = (url: string) => {
    const f = allProven();
    f.service!.inboundRequestUrl = url;
    Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
    return f;
  };
  const redelivery = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status;

  it("sni=n with otherwise complete retries: every TLS handshake to a virtual host fails, refused", () => {
    expect(retriesRecoverDelivery(`${URL_RETRY}&sni=n`)).toBe(false);
    expect(redelivery(noFallback(`${URL_RETRY}&sni=n`))).toBe("fail");
  });

  it("sni=y or sni omitted: certified as before", () => {
    expect(retriesRecoverDelivery(`${URL_RETRY}&sni=y`)).toBe(true);
    expect(retriesRecoverDelivery(URL_RETRY)).toBe(true);
  });

  for (const e of ["ashburn", "dublin", "ashburn-ix"]) {
    it(`a ONE-edge list (e=${e}) gives retries no alternate origin: refused`, () => {
      expect(retriesRecoverDelivery(`${URL_RETRY_NO_EDGES}&e=${e}`)).toBe(false);
      expect(redelivery(noFallback(`${URL_RETRY_NO_EDGES}&e=${e}`))).toBe("fail");
    });
  }

  it("two or more edges: certified", () => {
    expect(retriesRecoverDelivery(`${URL_RETRY_NO_EDGES}&e=ashburn,umatilla`)).toBe(true);
    expect(retriesRecoverDelivery(`${URL_RETRY_NO_EDGES}&e=dublin,sydney,ashburn`)).toBe(true);
  });

  it("a same-route POST fallback still recovers a one-edge or sni=n primary", () => {
    for (const frag of ["&sni=n", "&e=ashburn"]) {
      const f = noFallback(`${URL_RETRY_NO_EDGES}${frag}`);
      Object.assign(f.service!, { fallbackUrl: URL_EDGES, fallbackMethod: "POST" });
      expect(redelivery(f)).toBe("pass");
    }
  });

  it("under a matching Rule the Setting decides, so the URL's sni/e are not consulted", () => {
    const f = noFallback(`${URL_RETRY_NO_EDGES}&e=ashburn`);
    f.webhookRules = {
      matched: true,
      settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY }],
    };
    expect(redelivery(f)).toBe("pass");
  });
});

describe("the FALLBACK's transport is judged like the primary's (Codex P1 4265522953)", () => {
  /** A primary whose retries do not recover (5xx only), so only the fallback can. */
  const PRIMARY_NO_RECOVERY = `${URL_OK}#ct=1000&rt=5000&rp=5xx`;
  const withFallback = (fallbackUrl: string) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: PRIMARY_NO_RECOVERY, fallbackUrl, fallbackMethod: "POST" });
    return f;
  };
  const status = (f: InboundStopFacts, id: string) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === id)?.status;

  for (const [why, frag] of [
    ["sni=n (the fallback TLS handshake to this virtual host fails)", "#sni=n"],
    ["a one-edge e=", "#e=ashburn"],
    ["sni=n among other overrides", "#ct=1000&sni=n&e=ashburn,umatilla"],
    // Codex P2 4266813200: no e = Twilio's single default edge, ashburn.
    ["no fragment (the single default edge)", ""],
    ["timeouts only (the single default edge)", "#ct=1000&rt=5000"],
  ] as const) {
    it(`primary refused + same-route POST fallback with ${why}: never ready`, () => {
      const f = withFallback(`${URL_OK}${frag}`);
      expect(status(f, "stop_redelivery")).toBe("fail");
      expect(evaluateInboundStopPreflight(f).ready).toBe(false);
    });
  }

  for (const [why, url] of [
    ["two edges", URL_EDGES],
    ["sni=y and full own recovery", `${URL_OK}#sni=y&ct=1000&rt=5000&rp=all&e=ashburn,umatilla`],
    ["full own recovery and three edges", `${URL_OK}#ct=1000&rt=5000&rp=4xx,ct,rt,5xx&e=dublin,sydney,ashburn`],
  ] as const) {
    it(`POSITIVE CONTROL: a safe same-route fallback (${why}) recovers: ready`, () => {
      const f = withFallback(url);
      expect(status(f, "stop_redelivery")).toBe("pass");
      expect(evaluateInboundStopPreflight(f).ready).toBe(true);
    });
  }

  it("NUMBER path: the number's sms_fallback_url is judged the same way", () => {
    const f = allProven();
    Object.assign(f.service!, {
      useInboundWebhookOnNumber: true,
      numberSmsUrl: PRIMARY_NO_RECOVERY,
      numberSmsMethod: "POST",
      numberSmsApplicationSid: null,
      numberSmsFallbackUrl: `${URL_OK}#sni=n`,
      numberSmsFallbackMethod: "POST",
    });
    expect(status(f, "stop_redelivery")).toBe("fail");
    f.service!.numberSmsFallbackUrl = URL_EDGES;
    expect(status(f, "stop_redelivery")).toBe("pass");
  });

  it("POOL path: a member whose only recovery is an sni=n fallback fails sender_pool; a safe one passes", () => {
    const f = allProven();
    Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null });
    f.routedFromNumber = undefined;
    const member = (fb: string) => ({
      phoneNumber: "+14165550101",
      smsUrl: PRIMARY_NO_RECOVERY,
      smsMethod: "POST",
      smsApplicationSid: null,
      smsFallbackUrl: fb,
      smsFallbackMethod: "POST",
    });
    f.service!.senderPool = [
      { phoneNumber: "+14165550100", smsUrl: URL_RETRY, smsMethod: "POST", smsApplicationSid: null },
      member(`${URL_OK}#sni=n`),
    ];
    expect(status(f, "sender_pool")).toBe("fail");
    f.service!.senderPool[1] = member(URL_EDGES);
    expect(status(f, "sender_pool")).toBe("pass");
  });

  describe("under a matching Rule the Setting decides what it can", () => {
    const ruled = (fallbackUrl: string, primary = PRIMARY_NO_RECOVERY, ...settings: Array<Record<string, unknown>>) => {
      const f = withFallback(fallbackUrl);
      f.service!.inboundRequestUrl = primary;
      const base = { settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY };
      f.webhookRules = {
        matched: true,
        settings: (settings.length ? settings : [{ retryOn: ["HTTP_5XX"] }]).map((o) => ({ ...base, ...o })) as never,
      };
      return f;
    };

    it("a non-recovering Setting governs the fallback too: refused whatever the fallback URL says (Codex P1 4269949178)", () => {
      for (const fb of [URL_OK, URL_EDGES, `${URL_OK}#e=ashburn`, `${URL_OK}#sni=n`]) {
        expect(status(ruled(fb), "stop_redelivery")).toBe("fail");
      }
    });

    it("complete Setting retries, but the PRIMARY URL says sni=n: undetermined, unknown (no fallback either)", () => {
      const f = ruled(URL_OK, `${URL_OK}#sni=n`, {});
      Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
      expect(status(f, "stop_redelivery")).toBe("unknown");
      f.service!.inboundRequestUrl = URL_OK;
      expect(status(f, "stop_redelivery")).toBe("pass");
    });

    it("SPLIT: a 30% share without recovery is not rescued by any fallback (the fallback lands on the same split)", () => {
      const split = [{ settingType: "CUSTOMER" as const, percentage: 70 }, { settingType: "CUSTOMER" as const, percentage: 30, retryOn: ["HTTP_5XX"] }];
      expect(status(ruled(URL_EDGES, PRIMARY_NO_RECOVERY, ...split), "stop_redelivery")).toBe("fail");
      expect(status(ruled(URL_EDGES, PRIMARY_NO_RECOVERY, { settingType: "CUSTOMER" as const, percentage: 100 }, { settingType: "CUSTOMER" as const, percentage: 0, retryOn: ["HTTP_5XX"] }), "stop_redelivery")).toBe("pass");
    });
  });

  it("Rules unread: an sni=n or one-edge fallback is unknown, never certified", () => {
    for (const frag of ["#sni=n", "#e=ashburn"]) {
      const f = withFallback(`${URL_OK}${frag}`);
      f.webhookRules = undefined;
      expect(status(f, "stop_redelivery")).toBe("unknown");
    }
  });
});

describe("the live STOP proves only the opt-out configuration it ran under (Codex P1 4266130958)", () => {
  const stop = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_forwarded");

  it("POSITIVE CONTROL: forwarding configuration unchanged since the observed STOP: ready", () => {
    const f = allProven();
    expect(stop(f)?.status).toBe("pass");
    expect(evaluateInboundStopPreflight(f).ready).toBe(true);
  });

  it("the service now DROPS keyword messages: refused, even with a perfect earlier observation", () => {
    const f = allProven();
    f.optOutConfiguration = { dropsKeywordMessages: true, lastChangedAt: "2026-10-13T00:00:00Z" };
    expect(stop(f)?.status).toBe("fail");
    expect(evaluateInboundStopPreflight(f).blockers).toEqual(["stop_forwarded"]);
  });

  it("dropping keyword messages fails even before any live STOP is observed", () => {
    const f = allProven();
    f.liveStopObservation = undefined;
    f.optOutConfiguration = { dropsKeywordMessages: true, lastChangedAt: null };
    expect(stop(f)?.status).toBe("fail");
  });

  for (const [why, mutate] of [
    ["the configuration changed AFTER the observation (back to forwarding)", (f: InboundStopFacts) => (f.optOutConfiguration = { dropsKeywordMessages: false, lastChangedAt: "2026-10-13T00:00:00Z" })],
    ["the configuration changed at the very instant of the observation", (f: InboundStopFacts) => (f.optOutConfiguration = { dropsKeywordMessages: false, lastChangedAt: "2026-10-12T12:00:00Z" })],
    ["the opt-out configuration not read", (f: InboundStopFacts) => (f.optOutConfiguration = undefined)],
    ["whether it drops keywords not read", (f: InboundStopFacts) => (f.optOutConfiguration = { dropsKeywordMessages: null, lastChangedAt: "2026-10-01T00:00:00Z" })],
    ["its last change time not read", (f: InboundStopFacts) => (f.optOutConfiguration = { dropsKeywordMessages: false, lastChangedAt: null })],
    ["the observation's time not read", (f: InboundStopFacts) => (f.liveStopObservation = { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: true })],
    ["an unparseable observation time", (f: InboundStopFacts) => (f.liveStopObservation = { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: true, observedAt: "last week" })],
  ] as const) {
    it(`${why}: unknown, a blocker (re-verify)`, () => {
      const f = allProven();
      mutate(f);
      expect(stop(f)?.status).toBe("unknown");
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["stop_forwarded"]);
    });
  }

  it("the operator is told WHICH fact is missing: unread times vs a later change", () => {
    const unread = allProven();
    unread.optOutConfiguration = { dropsKeywordMessages: false, lastChangedAt: null };
    expect(stop(unread)?.detail).toMatch(/not read/);
    const later = allProven();
    later.optOutConfiguration = { dropsKeywordMessages: false, lastChangedAt: "2026-10-13T00:00:00Z" };
    expect(stop(later)?.detail).toMatch(/changed after the live STOP.*re-verify/);
  });

  it("a FAILED observation still fails, whatever the configuration's freshness", () => {
    const f = allProven();
    f.liveStopObservation = { reachedRoute: true, routeStatus: 403, phoneWideOptOutStamped: null, observedAt: "2026-10-12T12:00:00Z" };
    expect(stop(f)?.status).toBe("fail");
  });
});

describe("an OMITTED edge list is Twilio's single default edge, ashburn (Codex P2 4266813200)", () => {
  const status = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status;

  it("complete retries with no e=: no alternate origin, refused; with two edges, certified", () => {
    expect(retriesRecoverDelivery(URL_RETRY_NO_EDGES)).toBe(false);
    expect(retriesRecoverDelivery(URL_RETRY)).toBe(true);
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: URL_RETRY_NO_EDGES, fallbackUrl: null, fallbackMethod: null });
    expect(status(f)).toBe("fail");
    expect(evaluateInboundStopPreflight(f).ready).toBe(false);
  });

  it("an edgeless primary is rescued only by a fallback that has two edges", () => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: URL_RETRY_NO_EDGES, fallbackUrl: URL_OK, fallbackMethod: "POST" });
    expect(status(f)).toBe("fail");
    f.service!.fallbackUrl = URL_EDGES;
    expect(status(f)).toBe("pass");
  });

  it("under a matching Rule the Setting's edgeZones govern, so an edgeless URL is not refused here", () => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: null, fallbackMethod: null });
    f.webhookRules = {
      matched: true,
      settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY }],
    };
    expect(status(f)).toBe("pass");
  });
});

describe("a base with an EMPTY query or fragment delimiter is refused (Codex P2 4267597865)", () => {
  for (const base of ["https://hone.example?", "https://hone.example#", "https://hone.example/?", "https://hone.example/#/"]) {
    it(`${base}: the route path would be query/fragment text, refused`, () => {
      expect(expectedInboundWebhookUrl({ TWILIO_WEBHOOK_BASE_URL: base })).toEqual({ ok: false, reason: "base_has_path_query_or_fragment" });
      const f = allProven();
      f.env = { ...f.env, TWILIO_WEBHOOK_BASE_URL: base };
      expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "base_url")?.status).toBe("fail");
    });
  }
});

describe("the fallback must have budget for one whole attempt, tt >= ct + rt (Codex P2 4267597869)", () => {
  const PRIMARY_NO_RECOVERY = `${URL_OK}#ct=1000&rt=5000&rp=5xx&e=ashburn,umatilla`;
  const status = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status;
  const viaFallback = (fallbackUrl: string) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: PRIMARY_NO_RECOVERY, fallbackUrl, fallbackMethod: "POST" });
    return f;
  };

  for (const [why, frag, want] of [
    ["tt=100 (times out before the handler can finish)", "#tt=100&ct=1000&rt=5000&e=ashburn,umatilla", "fail"],
    ["default ct/rt (5000 + 15000) over the default 15000 total", "#e=ashburn,umatilla", "fail"],
    ["tt one ms short of ct + rt", "#tt=5999&ct=1000&rt=5000&e=ashburn,umatilla", "fail"],
    // An attempt fits (6000), but failing over to the second edge needs 2 * ct + rt = 7000 (Codex P1 4268714206).
    ["tt exactly ct + rt (no time to fail over to the second edge)", "#tt=6000&ct=1000&rt=5000&e=ashburn,umatilla", "fail"],
    // Codex P1 4269949178: the fallback must retry its OWN connect, read and 5xx failures within 2 * (ct + rt).
    ["tt exactly 2 * ct + rt, but the default policy (ct only)", "#tt=7000&ct=1000&rt=5000&e=ashburn,umatilla", "fail"],
    ["short timeouts, default policy (ct only: a 5xx or read timeout on the fallback is lost)", "#ct=1000&rt=5000&e=ashburn,umatilla", "fail"],
    ["rp=all with tt one ms short of 2 * (ct + rt)", "#tt=11999&ct=1000&rt=5000&rp=all&e=ashburn,umatilla", "fail"],
    ["rp=all with tt exactly 2 * (ct + rt)", "#tt=12000&ct=1000&rt=5000&rp=all&e=ashburn,umatilla", "pass"],
  ] as const) {
    it(`no Rule, fallback with ${why}: ${want}`, () => {
      const f = viaFallback(`${URL_OK}${frag}`);
      expect(status(f)).toBe(want);
      expect(evaluateInboundStopPreflight(f).ready).toBe(want === "pass");
    });
  }

  describe("under a matching Rule the live Settings' timeouts govern the fallback", () => {
    const ruled = (over: Record<string, unknown>, fallbackUrl = URL_EDGES) => {
      const f = viaFallback(fallbackUrl);
      f.webhookRules = {
        matched: true,
        settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY, retryOn: ["HTTP_5XX"], ...over }] as never,
      };
      return f;
    };
    it("a 5xx-only Setting cannot recover the fallback either: refused (Codex P1 4269949178)", () => {
      expect(status(ruled({}))).toBe("fail");
    });
    it("a fully recovering Setting: the primary itself recovers, the fallback is not needed", () => {
      expect(status(ruled({ retryOn: ["ALL"] }))).toBe("pass");
      expect(status(ruled({ retryOn: ["ALL"] }, `${URL_OK}#tt=100`))).toBe("pass");
    });
    it("Setting totalTimeoutMs 100: the fallback cannot finish an attempt, refused", () => {
      expect(status(ruled({ totalTimeoutMs: 100 }))).toBe("fail");
    });
    it("a Setting timeout not read: unknown", () => {
      expect(status(ruled({ connectTimeoutMs: null }))).toBe("unknown");
    });
  });
});

describe("Static Proxy makes Twilio ignore e=, so an edge list proves nothing under it (Codex P2 4267597875)", () => {
  const status = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status;

  for (const [why, sp, want] of [
    ["known off", false, "pass"],
    ["enabled", true, "unknown"],
    ["not read (null)", null, "unknown"],
    ["not read (absent)", undefined, "unknown"],
  ] as const) {
    it(`no Rule, complete two-edge retries, Static Proxy ${why}: ${want}`, () => {
      const f = allProven();
      Object.assign(f.service!, { fallbackUrl: null, fallbackMethod: null });
      f.staticProxyEnabled = sp;
      expect(status(f)).toBe(want);
      expect(evaluateInboundStopPreflight(f).ready).toBe(want === "pass");
    });
  }

  it("a two-edge FALLBACK is undetermined under Static Proxy too", () => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: `${URL_OK}#ct=1000&rt=5000&rp=5xx&e=ashburn,umatilla`, fallbackUrl: URL_EDGES, fallbackMethod: "POST" });
    f.staticProxyEnabled = true;
    expect(status(f)).toBe("unknown");
    f.staticProxyEnabled = false;
    expect(status(f)).toBe("pass");
  });

  it("standalone retriesRecoverDelivery takes the fact: Static Proxy on or unread is never certified", () => {
    expect(retriesRecoverDelivery(URL_RETRY, false)).toBe(true);
    expect(retriesRecoverDelivery(URL_RETRY, true)).toBe(false);
    expect(retriesRecoverDelivery(URL_RETRY, null)).toBe(false);
  });

  it("under a matching Rule the Setting's edgeZones govern: Static Proxy is not consulted here", () => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: null, fallbackMethod: null });
    f.staticProxyEnabled = true;
    f.webhookRules = {
      matched: true,
      settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY }],
    };
    expect(status(f)).toBe("pass");
  });
});

describe("an edge list is resilience only if a connect failure is RETRIED onto the next edge (Codex P1 4268714206)", () => {
  const PRIMARY_NO_RECOVERY = `${URL_OK}#ct=1000&rt=5000&rp=5xx&e=ashburn,umatilla`;
  const status = (fallbackUrl: string) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: PRIMARY_NO_RECOVERY, fallbackUrl, fallbackMethod: "POST" });
    return evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status;
  };
  for (const [why, frag, want] of [
    ["rc=0 (no retry, so never the second edge)", "#ct=1000&rt=5000&rc=0&e=ashburn,umatilla", "fail"],
    ["rp=5xx (a connect/TLS failure is not retried)", "#ct=1000&rt=5000&rp=5xx&e=ashburn,umatilla", "fail"],
    ["rp=rt,5xx (no ct)", "#ct=1000&rt=5000&rp=rt,5xx&e=ashburn,umatilla", "fail"],
    // Codex P1 4269949178: edge failover alone is not enough, the fallback must also retry rt and 5xx.
    ["the default policy (ct) and default rc (1)", "#ct=1000&rt=5000&e=ashburn,umatilla", "fail"],
    ["rp=ct,5xx (read timeouts on the fallback lost)", "#ct=1000&rt=5000&rp=ct,5xx&e=dublin,sydney", "fail"],
    ["rp=ct,rt (a 5xx on the fallback lost)", "#ct=1000&rt=5000&rp=ct,rt&e=dublin,sydney", "fail"],
    ["rp=all, rc=2", "#ct=1000&rt=5000&rp=all&rc=2&e=ashburn,umatilla", "pass"],
    ["rp=ct,rt,5xx (a transient 400 on the fallback lost)", "#ct=1000&rt=5000&rp=ct,rt,5xx&e=dublin,sydney", "fail"],
    ["rp=4xx,ct,rt,5xx", "#ct=1000&rt=5000&rp=4xx,ct,rt,5xx&e=dublin,sydney", "pass"],
  ] as const) {
    it(`no Rule, two-edge fallback with ${why}: ${want}`, () => {
      expect(status(`${URL_OK}${frag}`)).toBe(want);
    });
  }

  it("Rules unread: an edge list without connect retries is unknown, not certified", () => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: PRIMARY_NO_RECOVERY, fallbackUrl: `${URL_OK}#ct=1000&rt=5000&rc=0&e=ashburn,umatilla`, fallbackMethod: "POST" });
    f.webhookRules = undefined;
    expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status).toBe("unknown");
  });
});

describe("NEGATIVE CONTROLS — a fallback certifies only by recovering its OWN failures (Codex P1 4269949178, review 5517134248)", () => {
  const PRIMARY_NO_RECOVERY = `${URL_OK}#ct=1000&rt=5000&rp=5xx&e=ashburn,umatilla`;
  const verdict = (fallbackUrl: string, mutate?: (f: InboundStopFacts) => void) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: PRIMARY_NO_RECOVERY, fallbackUrl, fallbackMethod: "POST" });
    mutate?.(f);
    const r = evaluateInboundStopPreflight(f);
    return { status: r.checks.find((c) => c.id === "stop_redelivery")?.status, ready: r.ready };
  };
  const E = "&e=ashburn,umatilla";
  for (const [why, frag] of [
    ["ct only", `#ct=1000&rt=5000&rp=ct${E}`],
    ["ct + 5xx without rt", `#ct=1000&rt=5000&rp=ct,5xx${E}`],
    ["ct + rt without 5xx", `#ct=1000&rt=5000&rp=ct,rt${E}`],
    ["no retries (rc=0)", `#ct=1000&rt=5000&rp=all&rc=0${E}`],
    ["an insufficient budget", `#ct=1000&rt=5000&tt=11999&rp=all${E}`],
    ["the defaults' budget (2 * (5000 + 15000) > 15000)", `#rp=all${E}`],
    ["a malformed fragment", `#rp=all&ct=oops${E}`],
  ] as const) {
    it(`no Rule, fallback with ${why}: never certified, never ready`, () => {
      expect(verdict(`${URL_OK}${frag}`)).toEqual({ status: "fail", ready: false });
    });
  }

  it("POSITIVE CONTROL: full own recovery (ct, rt, 5xx; rc >= 1; 2 * (ct + rt) <= tt; two edges; Static Proxy off)", () => {
    expect(verdict(URL_EDGES)).toEqual({ status: "pass", ready: true });
  });

  it("incomplete effective facts: Static Proxy unread, or a live Setting's retryOn unread, stay unknown", () => {
    expect(verdict(URL_EDGES, (f) => (f.staticProxyEnabled = null))).toEqual({ status: "unknown", ready: false });
    expect(
      verdict(URL_EDGES, (f) => {
        f.webhookRules = {
          matched: true,
          settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY, retryOn: null }],
        };
      }),
    ).toEqual({ status: "unknown", ready: false });
  });

  it("the fallback's method must be exactly POST (a non-string method is not POST)", () => {
    expect(verdict(URL_EDGES, (f) => Object.assign(f.service!, { fallbackMethod: 7 as unknown as string })).status).toBe("fail");
  });
});

describe("NEGATIVE CONTROLS — opt-out passes only on an EXPLICIT false (Codex P2 4270134232)", () => {
  const run = (optOut: unknown, stop?: unknown) => {
    const f = allProven();
    f.optOutConfiguration = optOut as InboundStopFacts["optOutConfiguration"];
    if (stop !== undefined) f.liveStopObservation = stop as InboundStopFacts["liveStopObservation"];
    const r = evaluateInboundStopPreflight(f);
    return { status: r.checks.find((c) => c.id === "stop_forwarded")?.status, ready: r.ready };
  };

  it("POSITIVE CONTROL: explicit false, unchanged since the observed STOP", () => {
    expect(run({ dropsKeywordMessages: false, lastChangedAt: "2026-10-01T00:00:00Z" })).toEqual({ status: "pass", ready: true });
  });

  it("explicit true refuses", () => {
    expect(run({ dropsKeywordMessages: true, lastChangedAt: "2026-10-01T00:00:00Z" })).toEqual({ status: "fail", ready: false });
  });

  for (const [why, optOut] of [
    ["the flag ABSENT (the reported pass-through)", { lastChangedAt: "2026-10-01T00:00:00Z" }],
    ["the flag null", { dropsKeywordMessages: null, lastChangedAt: "2026-10-01T00:00:00Z" }],
    ["the flag 0", { dropsKeywordMessages: 0, lastChangedAt: "2026-10-01T00:00:00Z" }],
    ["the flag empty string", { dropsKeywordMessages: "", lastChangedAt: "2026-10-01T00:00:00Z" }],
    ["the flag the STRING 'false'", { dropsKeywordMessages: "false", lastChangedAt: "2026-10-01T00:00:00Z" }],
    ["the whole object null (must not throw)", null],
    ["the whole object empty", {}],
    ["lastChangedAt a number", { dropsKeywordMessages: false, lastChangedAt: 1696118400000 }],
    ["lastChangedAt empty", { dropsKeywordMessages: false, lastChangedAt: "" }],
    ["lastChangedAt an ARRAY holding a date (coerces to a parseable string)", { dropsKeywordMessages: false, lastChangedAt: ["2026-10-01T00:00:00Z"] }],
  ] as const) {
    it(`${why}: unknown, and ready can never become true`, () => {
      expect(run(optOut)).toEqual({ status: "unknown", ready: false });
    });
  }

  for (const [why, stop] of [
    ["the observation object null (must not throw)", null],
    ["routeStatus the STRING '200'", { reachedRoute: true, routeStatus: "200", phoneWideOptOutStamped: true, observedAt: "2026-10-12T12:00:00Z" }],
    ["reachedRoute the STRING 'true'", { reachedRoute: "true", routeStatus: 200, phoneWideOptOutStamped: true, observedAt: "2026-10-12T12:00:00Z" }],
    ["the stamp 1 instead of true", { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: 1, observedAt: "2026-10-12T12:00:00Z" }],
    ["observedAt a number", { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: true, observedAt: 1697112000000 }],
  ] as const) {
    it(`malformed observation, ${why}: unknown, never ready`, () => {
      expect(run({ dropsKeywordMessages: false, lastChangedAt: "2026-10-01T00:00:00Z" }, stop)).toEqual({ status: "unknown", ready: false });
    });
  }
});

describe("NEGATIVE CONTROLS — the route's transient 400 must be retried too (Codex P1 4270801222)", () => {
  // app/api/twilio/inbound-sms/route.ts answers 400 when reading the body
  // throws, before any suppression: only a 4xx-retrying policy recovers it.
  const urlStatus = (inbound: string) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: inbound, fallbackUrl: null, fallbackMethod: null });
    const r = evaluateInboundStopPreflight(f);
    return { status: r.checks.find((c) => c.id === "stop_redelivery")?.status, ready: r.ready };
  };
  const E = "&ct=1000&rt=5000&e=ashburn,umatilla";

  it("rp=ct,rt,5xx (no 4xx): refused, never ready", () => {
    expect(urlStatus(`${URL_OK}#rp=ct,rt,5xx${E}`)).toEqual({ status: "fail", ready: false });
  });
  it("POSITIVE CONTROLS: rp=4xx,5xx,ct,rt and rp=all recover", () => {
    expect(urlStatus(`${URL_OK}#rp=4xx,5xx,ct,rt${E}`)).toEqual({ status: "pass", ready: true });
    expect(urlStatus(`${URL_OK}#rp=all${E}`)).toEqual({ status: "pass", ready: true });
  });
  it("standalone: retriesRecoverDelivery demands 4xx", () => {
    expect(retriesRecoverDelivery(`${URL_OK}#rp=ct,rt,5xx${E}`)).toBe(false);
    expect(retriesRecoverDelivery(`${URL_OK}#rp=4xx,ct,rt,5xx${E}`)).toBe(true);
  });
  it("a live Setting without HTTP_4XX: refused; with it, or ALL: recovers", () => {
    const ruled = (retryOn: string[]) => {
      const f = allProven();
      Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: null, fallbackMethod: null });
      f.webhookRules = {
        matched: true,
        settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY, retryOn }],
      };
      return evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status;
    };
    expect(ruled(["HTTP_5XX", "CONNECTION_TIMEOUT", "READ_TIMEOUT"])).toBe("fail");
    expect(ruled(["HTTP_4XX", "HTTP_5XX", "CONNECTION_TIMEOUT", "READ_TIMEOUT"])).toBe("pass");
    expect(ruled(["ALL"])).toBe("pass");
  });
  it("a fallback without 4xx retries does not rescue a non-recovering primary", () => {
    const f = allProven();
    Object.assign(f.service!, {
      inboundRequestUrl: `${URL_OK}#rp=5xx${E}`,
      fallbackUrl: `${URL_OK}#rp=ct,rt,5xx${E}`,
      fallbackMethod: "POST",
    });
    expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status).toBe("fail");
  });
});

describe("the operator guidance names the FOUR implemented classes and is itself sufficient (Codex P2 4272303186)", () => {
  const E = "&ct=1000&rt=5000&e=ashburn,umatilla";
  const redelivery = (inbound: string, mutate?: (f: InboundStopFacts) => void) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: inbound, fallbackUrl: null, fallbackMethod: null });
    mutate?.(f);
    return evaluateInboundStopPreflight(f);
  };
  const detail = (r: ReturnType<typeof evaluateInboundStopPreflight>) => r.checks.find((c) => c.id === "stop_redelivery")?.detail ?? "";

  it("the failure instruction recommends rp=4xx,5xx,ct,rt / rp=all and the Setting classes, never the stale ct,rt,5xx", () => {
    const d = detail(redelivery(`${URL_OK}#rp=ct,rt,5xx${E}`));
    expect(d).toMatch(/rp=all or rp=4xx,5xx,ct,rt/);
    expect(d).toMatch(/HTTP_4XX, HTTP_5XX, CONNECTION_TIMEOUT and READ_TIMEOUT/);
    expect(d).toMatch(/rc>=1; tt>=2\*\(ct\+rt\)/);
    expect(d).not.toMatch(/rp=all or ct,rt,5xx/);
    // Retries are bounded, and a bad signature is never "fixed" by retrying.
    expect(d).toMatch(/bounded by rc/);
    expect(d).toMatch(/never by retrying/);
  });

  it("BOTH pass descriptions name 4xx (URL overrides and Settings), with the partial-response limit", () => {
    const url = detail(redelivery(`${URL_OK}#rp=4xx,5xx,ct,rt${E}`));
    expect(url).toMatch(/4xx and 5xx/);
    expect(url).toMatch(/rp=4xx,5xx,ct,rt/);
    expect(url).toMatch(/partial response is never retried/);
    const setting = detail(
      redelivery(URL_OK, (f) => {
        f.webhookRules = {
          matched: true,
          settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY }],
        };
      }),
    );
    expect(setting).toMatch(/4xx and 5xx/);
    expect(setting).toMatch(/HTTP_4XX/);
    expect(setting).toMatch(/partial response is never retried/);
  });

  it("the EXACT recommended policy passes the policy check; the same policy without 4xx is still refused", () => {
    const recommended = `${URL_OK}#ct=1000&rt=5000&rc=2&rp=4xx,5xx,ct,rt&e=ashburn,umatilla`;
    expect(retriesRecoverDelivery(recommended)).toBe(true);
    expect(redelivery(recommended).checks.find((c) => c.id === "stop_redelivery")?.status).toBe("pass");
    expect(redelivery(`${URL_OK}#ct=1000&rt=5000&rc=2&rp=5xx,ct,rt&e=ashburn,umatilla`).checks.find((c) => c.id === "stop_redelivery")?.status).toBe("fail");
  });

  for (const [why, mutate, blocker] of [
    ["the Rules unread", (f: InboundStopFacts) => (f.webhookRules = undefined), "webhook_rules"],
    ["the signing account unconfirmed", (f: InboundStopFacts) => (f.honeAccountSid = null), "signing_account"],
    ["a SHARED_KEY Setting", (f: InboundStopFacts) => (f.webhookRules = { matched: true, settings: [{ settingType: "CUSTOMER" as const, percentage: 100, authScheme: "NONE", signatureType: "SHARED_KEY", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY }] }), "webhook_rules"],
    ["signing not proven under the current credentials", (f: InboundStopFacts) => (f.signatureProof = { lastVerifiedCallbackAt: null, credentialsActiveSince: null }), "signing_proven"],
    ["no live STOP observed", (f: InboundStopFacts) => (f.liveStopObservation = undefined), "stop_forwarded"],
    ["the opt-out flag absent", (f: InboundStopFacts) => (f.optOutConfiguration = { lastChangedAt: "2026-10-01T00:00:00Z" } as never), "stop_forwarded"],
  ] as const) {
    it(`the recommended policy does NOT make the whole preflight ready with ${why}`, () => {
      const r = redelivery(`${URL_OK}#ct=1000&rt=5000&rc=2&rp=4xx,5xx,ct,rt&e=ashburn,umatilla`, mutate);
      expect(r.ready).toBe(false);
      expect(r.blockers).toContain(blocker);
    });
  }
});

describe("the live STOP proves only the handler and database it ran against (Codex P1 4273253239)", () => {
  const run = (mutate: (f: InboundStopFacts) => void) => {
    const f = allProven();
    mutate(f);
    const r = evaluateInboundStopPreflight(f);
    const c = r.checks.find((x) => x.id === "stop_forwarded");
    return { status: c?.status, detail: c?.detail ?? "", ready: r.ready };
  };

  it("POSITIVE CONTROL: the STOP postdates the opt-out change, the deployment and the migration", () => {
    expect(run(() => undefined)).toMatchObject({ status: "pass", ready: true });
  });

  for (const [why, activation] of [
    ["a handler deployed AFTER the STOP", { handlerDeployedAt: "2026-10-13T00:00:00Z", databaseMigratedAt: "2026-10-10T00:00:00Z" }],
    ["a migration applied AFTER the STOP", { handlerDeployedAt: "2026-10-11T00:00:00Z", databaseMigratedAt: "2026-10-13T00:00:00Z" }],
    ["a deployment at the very instant of the STOP", { handlerDeployedAt: "2026-10-12T12:00:00Z", databaseMigratedAt: "2026-10-10T00:00:00Z" }],
  ] as const) {
    it(`${why}: stale, unknown, never ready (re-verify)`, () => {
      const r = run((f) => (f.currentActivation = { ...activation }));
      expect(r).toMatchObject({ status: "unknown", ready: false });
      expect(r.detail).toMatch(/deployed or the database migrated after the live STOP/);
    });
  }

  for (const [why, activation] of [
    ["absent", undefined],
    ["null", null],
    ["the deployment time null", { handlerDeployedAt: null, databaseMigratedAt: "2026-10-10T00:00:00Z" }],
    ["the migration time null", { handlerDeployedAt: "2026-10-11T00:00:00Z", databaseMigratedAt: null }],
    ["an unparseable time", { handlerDeployedAt: "yesterday", databaseMigratedAt: "2026-10-10T00:00:00Z" }],
    ["a numeric time", { handlerDeployedAt: 1696118400000, databaseMigratedAt: "2026-10-10T00:00:00Z" }],
    ["an empty object", {}],
  ] as const) {
    it(`activation ${why}: unknown, never ready`, () => {
      const r = run((f) => (f.currentActivation = activation as never));
      expect(r).toMatchObject({ status: "unknown", ready: false });
      expect(r.detail).toMatch(/was not read/);
    });
  }

  it("a fresh STOP after the deployment and migration restores the pass", () => {
    const r = run((f) => {
      f.currentActivation = { handlerDeployedAt: "2026-10-13T00:00:00Z", databaseMigratedAt: "2026-10-13T00:00:00Z" };
      f.liveStopObservation = { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: true, observedAt: "2026-10-13T06:00:00Z" };
    });
    expect(r).toMatchObject({ status: "pass", ready: true });
  });

  it("the opt-out ordering still binds: a fresh deployment does not excuse a later opt-out change", () => {
    const r = run((f) => (f.optOutConfiguration = { dropsKeywordMessages: false, lastChangedAt: "2026-10-12T13:00:00Z" }));
    expect(r).toMatchObject({ status: "unknown", ready: false });
  });
});

// Codex P2 4305024182: a Rule pointing at Twilio's SYSTEM Setting (the first
// step of migrating an existing webhook) keeps reading connection overrides
// from the webhook URL, so that share is judged by the URL's own retries and
// transport, never by the Setting's retry fields. CUSTOMER shares keep the
// Setting's policy; an unread type is unknown.
describe("a SYSTEM Setting's share is judged by the webhook URL's overrides", () => {
  const NO_RETRIES = { retryOn: [], retryCount: 0, totalTimeoutMs: undefined, connectTimeoutMs: undefined, readTimeoutMs: undefined };
  const share = (settingType: unknown, percentage: number, recovery: object) =>
    ({ settingType, percentage, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", edgeZones: "omitted", ...recovery }) as never;
  const redelivery = (url: string, settings: unknown[]) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: url, fallbackUrl: null, fallbackMethod: null });
    f.webhookRules = { matched: true, settings: settings as never };
    return evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery")?.status;
  };

  it("SYSTEM at 100 with a recovering URL: passes, though the Setting itself carries no retries", () => {
    expect(redelivery(URL_RETRY, [share("SYSTEM", 100, NO_RETRIES)])).toBe("pass");
  });

  it("control: the SAME Setting typed CUSTOMER is judged by its own (absent) retries and fails", () => {
    expect(redelivery(URL_RETRY, [share("CUSTOMER", 100, NO_RETRIES)])).toBe("fail");
  });

  it("SYSTEM at 100 with a URL that does not recover, and no fallback: fails, whatever the Setting's fields say", () => {
    expect(redelivery(URL_OK, [share("SYSTEM", 100, SETTING_RECOVERY)])).toBe("fail");
  });

  it("a mixed SYSTEM/CUSTOMER rollout: every share must recover on its own terms", () => {
    expect(redelivery(URL_RETRY, [share("SYSTEM", 70, NO_RETRIES), share("CUSTOMER", 30, SETTING_RECOVERY)])).toBe("pass");
    expect(redelivery(URL_RETRY, [share("SYSTEM", 70, NO_RETRIES), share("CUSTOMER", 30, NO_RETRIES)])).toBe("fail");
    expect(redelivery(URL_OK, [share("SYSTEM", 70, SETTING_RECOVERY), share("CUSTOMER", 30, SETTING_RECOVERY)])).toBe("fail");
  });

  it.each([[undefined], [null], ["OTHER"]])("a Setting type of %s is unknown, never ready", (t) => {
    expect(redelivery(URL_RETRY, [share(t, 100, SETTING_RECOVERY)])).toBe("unknown");
  });
});

describe("NEGATIVE CONTROLS — a Rule's split must be COMPLETE before any Setting is certified (Codex P1 4274472921)", () => {
  const healthy = (percentage: unknown) =>
    ({ settingType: "CUSTOMER", percentage, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", ...SETTING_RECOVERY }) as never;
  const run = (percentages: unknown[]) => {
    const f = allProven();
    Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: null, fallbackMethod: null });
    f.webhookRules = { matched: true, settings: percentages.map(healthy) };
    const r = evaluateInboundStopPreflight(f);
    const st = (id: string) => r.checks.find((c) => c.id === id)?.status;
    return { rules: st("webhook_rules"), redelivery: st("stop_redelivery"), zones: st("webhook_zones"), ready: r.ready };
  };

  for (const [why, shares] of [
    ["one healthy 50% Setting, its partner omitted (the reported case)", [50]],
    ["two Settings summing to 90", [60, 30]],
    ["two Settings summing to 110", [70, 40]],
    ["three Settings summing to 100", [50, 30, 20]],
    ["fractional shares", [50.5, 49.5]],
    ["a negative share", [-10, 110]],
    ["a share over 100", [150]],
    ["a STRING share", ["100"]],
    ["a null share", [null]],
    ["no Settings", []],
  ] as const) {
    it(`${why}: nothing certified, never ready`, () => {
      const r = run([...shares]);
      expect(r.rules).toBe("unknown");
      expect(r.redelivery).toBe("unknown");
      expect(r.ready).toBe(false);
    });
  }

  for (const [why, shares] of [
    ["one Setting at 100", [100]],
    ["a 70/30 split", [70, 30]],
    ["a 100/0 rollout", [100, 0]],
  ] as const) {
    it(`POSITIVE CONTROL: ${why}, both healthy: ready`, () => {
      expect(run([...shares])).toEqual({ rules: "pass", redelivery: "pass", zones: "pass", ready: true });
    });
  }
});
