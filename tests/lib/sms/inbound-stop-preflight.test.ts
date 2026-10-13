import { describe, expect, it } from "vitest";
import {
  evaluateInboundStopPreflight,
  expectedInboundWebhookUrl,
  redeliversServerErrors,
  type InboundStopFacts,
} from "@/lib/sms/inbound-stop-preflight";

// WILLOW-STOP-PREFLIGHT-01 (#824): the preflight's own decisions. Synthetic
// identifiers only. UNKNOWN is a blocker, never a pass.

const BASE = "https://hone.example";
const URL_OK = `${BASE}/api/twilio/inbound-sms`;
/** The expected URL with a connection override that redelivers a 5xx (Codex P1 4254444665). */
const URL_RETRY = `${URL_OK}#rp=5xx`;
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
  // The Webhooks configuration has settled (Operations COMPLETED, unchanged >= 60 s).
  webhookPropagation: { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 3600 },
  honeAccountSid: ACCOUNT,
  mappedStudioId: "studio-b",
  expectedStudioId: "studio-b",
  // The approved live STOP was accepted and stamped phone-wide.
  liveStopObservation: { reachedRoute: true, routeStatus: 200, phoneWideOptOutStamped: true },
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
        { phoneNumber: "+14165550100", smsUrl: `${URL_OK}#rp=5xx`, smsMethod: "POST", smsApplicationSid: null },
        { phoneNumber: "+14165550101", smsUrl: `${URL_OK}#ct=1000&rp=5xx,ct`, smsMethod: "POST", smsApplicationSid: null },
      ];
      expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
      f.service!.senderPool[1].smsUrl = `${URL_OK}#bogus=1`;
      expect(evaluateInboundStopPreflight(f).blockers).toEqual(["sender_pool"]);
    });
  });

  describe("STOP REDELIVERY: a STOP the route answers 500 must be retried (Codex P1 4254444665)", () => {
    const redelivery = (f: InboundStopFacts) => evaluateInboundStopPreflight(f).checks.find((c) => c.id === "stop_redelivery");

    for (const frag of ["#rp=5xx", "#rp=all", "#rp=ct,rt,5xx&rc=3", "#rc=1&rp=4xx,5xx"]) {
      it(`${frag}: redelivered`, () => {
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
    ] as const) {
      it(`${why}: blocked (unknown with no fallback read)`, () => {
        const f = allProven();
        f.service!.inboundRequestUrl = `${URL_OK}${frag}`;
        const r = evaluateInboundStopPreflight(f);
        expect(r.blockers).toEqual(["stop_redelivery"]);
        expect(redelivery(f)?.status).toBe("unknown");
      });
    }

    describe("TOTAL TIME: an explicit budget below Twilio's 15000 ms default is not certified (Codex P1 4254745407)", () => {
      for (const frag of ["#tt=100&rp=5xx", "#tt=14999&rp=all&rc=3"]) {
        it(`${frag}: not certified`, () => {
          expect(redeliversServerErrors(`${URL_OK}${frag}`)).toBe(false);
        });
      }
      for (const frag of ["#tt=15000&rp=5xx", "#rp=5xx", "#ct=500&rt=1000&tt=15000&rc=2&rp=4xx,5xx,ct,rt&sni=y&e=dublin,sydney"]) {
        it(`${frag}: certified`, () => {
          expect(redeliversServerErrors(`${URL_OK}${frag}`)).toBe(true);
        });
      }

      const ruleSetting = (totalTimeoutMs: number | null | undefined) => ({
        matched: true as const,
        settings: [
          { percentage: 100, authScheme: "NONE", signatureType: "ACCOUNT_AUTH_TOKEN", signatureAlgorithm: "HMAC_SHA1", retryOn: ["HTTP_5XX"], retryCount: 2, totalTimeoutMs },
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

    it("redeliversServerErrors never trusts an invalid fragment, even one naming rp=5xx", () => {
      expect(redeliversServerErrors(`${URL_OK}#rp=5xx`)).toBe(true);
      expect(redeliversServerErrors(`${URL_OK}#rp=5xx&sni=on`)).toBe(false);
      expect(redeliversServerErrors(`${URL_OK}#rp=5xx&rp=all`)).toBe(false);
      expect(redeliversServerErrors(URL_OK)).toBe(false);
      expect(redeliversServerErrors(null)).toBe(false);
    });

    describe("account Webhook Rules take precedence and decide signing (Codex P1s 4254537039, 4254655904; P2 4254655911)", () => {
      type Setting = {
        percentage: number | null;
        authScheme: string | null;
        signatureType: string | null;
        signatureAlgorithm: string | null;
        retryOn: string[] | null;
        retryCount: number | null;
      };
      const setting = (over: Partial<Setting> = {}): Setting => ({
        percentage: 100,
        authScheme: "NONE",
        signatureType: "ACCOUNT_AUTH_TOKEN",
        signatureAlgorithm: "HMAC_SHA1",
        retryOn: ["HTTP_5XX"],
        retryCount: 2,
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
        f.webhookRules = { matched: true, settings: [setting({ percentage: 70 }), setting({ percentage: 30, retryOn: ["HTTP_4XX"] })] };
        expect(redelivery(f)?.status).toBe("fail");
        f.webhookRules = { matched: true, settings: [setting({ percentage: 70 }), setting({ percentage: 30, signatureType: "NONE" })] };
        expect(rulesCheck(f)?.status).toBe("fail");
      });

      it("a 0/100 rollout: the zero-share Setting never receives traffic and is ignored", () => {
        const f = allProven();
        f.service!.inboundRequestUrl = URL_OK;
        f.webhookRules = {
          matched: true,
          settings: [
            setting({ percentage: 0, signatureType: "SHARED_KEY", retryOn: [], retryCount: 0 }),
            setting({ percentage: 100 }),
          ],
        };
        expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
      });

      it("shares not reported: unknown, never assumed", () => {
        const f = allProven();
        f.webhookRules = { matched: true, settings: [setting({ percentage: null })] };
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
          { phoneNumber: "+14165550100", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_OK, smsFallbackMethod: "POST" },
          { phoneNumber: "+14165550101", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_OK, smsFallbackMethod: "POST" },
        ];
        expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")?.status).toBe("pass");
      });

      it("one member with neither a 5xx retry nor its own fallback: blocked", () => {
        const f = poolRoute();
        f.service!.senderPool = [
          { phoneNumber: "+14165550100", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_OK, smsFallbackMethod: "POST" },
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

      it("exactly 60 s and COMPLETED: settled", () => {
        const f = allProven();
        f.webhookPropagation = { ruleOperationStatuses: ["COMPLETED"], secondsSinceLastConfigChange: 60 };
        expect(prop(f)?.status).toBe("pass");
      });

      it("no Rule written and settled for 60 s: settled", () => {
        const f = allProven();
        f.webhookPropagation = { ruleOperationStatuses: [], secondsSinceLastConfigChange: 60 };
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
          fallbackUrl: URL_OK, // the SERVICE fallback: ignored on this path
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
        Object.assign(f.service!, { numberSmsFallbackUrl: URL_OK, numberSmsFallbackMethod: "POST" });
        expect(redelivery(f)?.status).toBe("pass");
        expect(redelivery(f)?.detail).toMatch(/number's sms_fallback_url/);
      });

      it("the number's fallback by GET, or elsewhere, does not", () => {
        const f = numberRoute();
        Object.assign(f.service!, { numberSmsFallbackUrl: URL_OK, numberSmsFallbackMethod: "GET" });
        expect(redelivery(f)?.status).toBe("fail");
        Object.assign(f.service!, { numberSmsFallbackUrl: "https://elsewhere.example/sms", numberSmsFallbackMethod: "POST" });
        expect(redelivery(f)?.status).toBe("fail");
      });
    });

    it("a plain URL with a fallback to the SAME route by POST: redelivered", () => {
      const f = allProven();
      Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: URL_OK, fallbackMethod: "POST" });
      expect(evaluateInboundStopPreflight(f).blockers).toEqual([]);
    });

    it("a fallback that IS the route but whose method was not read: unknown, never misconfigured", () => {
      const f = allProven();
      Object.assign(f.service!, { inboundRequestUrl: URL_OK, fallbackUrl: URL_OK, fallbackMethod: undefined });
      expect(redelivery(f)?.status).toBe("unknown");
    });

    it("a pool member whose same-route fallback method was not read: unknown", () => {
      const f = allProven();
      Object.assign(f.service!, { useInboundWebhookOnNumber: true, numberSmsUrl: URL_RETRY, numberSmsMethod: "POST", numberSmsApplicationSid: null });
      f.routedFromNumber = undefined;
      f.service!.senderPool = [
        { phoneNumber: "+14165550100", smsUrl: URL_OK, smsMethod: "POST", smsApplicationSid: null, smsFallbackUrl: URL_OK },
      ];
      expect(evaluateInboundStopPreflight(f).checks.find((c) => c.id === "sender_pool")?.status).toBe("unknown");
    });

    for (const [why, fb] of [
      ["another URL", { fallbackUrl: "https://elsewhere.example/sms", fallbackMethod: "POST" }],
      ["GET", { fallbackUrl: URL_OK, fallbackMethod: "GET" }],
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
      f.service!.inboundRequestUrl = `${url}#rp=5xx`;
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
    percentage: 100,
    authScheme: "NONE",
    signatureType: "ACCOUNT_AUTH_TOKEN",
    signatureAlgorithm: "HMAC_SHA1",
    retryOn: ["HTTP_5XX"],
    retryCount: 2,
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
    expect(rulesCheck(withRule(setting({ percentage: 70 }), setting({ percentage: 30, authScheme: "OAUTH2" })))?.status).toBe("fail");
  });

  it("an OAUTH2 Setting with a 0% share receives no traffic: not counted", () => {
    expect(rulesCheck(withRule(setting({ percentage: 100 }), setting({ percentage: 0, authScheme: "OAUTH2" })))?.status).toBe("pass");
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
