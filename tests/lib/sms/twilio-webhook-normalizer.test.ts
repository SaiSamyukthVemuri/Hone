import { describe, expect, it } from "vitest";
import {
  effectiveConnectionSettings,
  normalizeTwilioWebhookUrl,
  sameTwilioWebhook,
} from "@/lib/sms/webhook-base";
import { inboundReaches } from "@/lib/sms/inbound-routing";

// ONE STRICT normalizer for Twilio connection-override fragments (Codex
// decision on #863; shared with #873). Values per
// twilio.com/docs/usage/webhooks/webhooks-connection-overrides (checked
// 2026-10-13). Anything not entirely valid is REFUSED, never stripped.

const BASE = "https://hone.care/api/twilio/inbound-sms";

describe("valid overrides are recognised; the URL before # is kept exactly", () => {
  it.each([
    ["#rp=5xx", { rp: ["5xx"] }],
    ["#rp=4xx,5xx&rc=3", { rp: ["4xx", "5xx"], rc: 3 }],
    ["#ct=100&rt=15000&tt=100&rc=0", { ct: 100, rt: 15000, tt: 100, rc: 0 }],
    ["#ct=10000", { ct: 10000 }],
    ["#rp=all&rc=5&sni=y&e=ashburn,frankfurt-ix", { rp: ["all"], rc: 5, sni: "y", e: ["ashburn", "frankfurt-ix"] }],
    ["#sni=n", { sni: "n" }],
  ])("%s", (frag, overrides) => {
    expect(normalizeTwilioWebhookUrl(`${BASE}${frag}`)).toEqual({ ok: true, url: BASE, overrides });
    expect(sameTwilioWebhook(`${BASE}${frag}`, BASE)).toBe(true);
  });

  it("no fragment: overrides null", () => {
    expect(normalizeTwilioWebhookUrl(BASE)).toEqual({ ok: true, url: BASE, overrides: null });
  });
});

describe("anything else is REFUSED, never stripped", () => {
  it.each([
    ["empty fragment", "#"],
    ["bare key", "#rp"],
    ["unknown key", "#rp=5xx&foo=1"],
    ["arbitrary anchor", "#section-2"],
    ["ct below range", "#ct=0"],
    ["ct above range", "#ct=10001"],
    ["rt above range", "#rt=15001"],
    ["rc above range", "#rc=6"],
    ["non-integer", "#rc=1.5"],
    ["leading zero", "#ct=0100"],
    ["signed", "#rc=+1"],
    ["sni not y/n", "#sni=on"],
    ["unknown retry token", "#rp=5xx,timeout"],
    ["duplicate retry token", "#rp=5xx,5xx"],
    ["empty token list", "#rp="],
    ["unknown edge", "#e=mars"],
    ["duplicate key", "#rc=1&rc=2"],
    ["double equals", "#rp=5xx=1"],
    ["trailing ampersand", "#rp=5xx&"],
  ])("%s (%s)", (_label, frag) => {
    expect(normalizeTwilioWebhookUrl(`${BASE}${frag}`)).toEqual({ ok: false, reason: "invalid_fragment" });
    expect(sameTwilioWebhook(`${BASE}${frag}`, BASE)).toBe(false);
  });

  it("any change before the # is a different endpoint", () => {
    for (const other of [`${BASE}?x=1#rp=5xx`, `${BASE}/#rp=5xx`, "https://HONE.care/api/twilio/inbound-sms#rp=5xx", "http://hone.care/api/twilio/inbound-sms#rp=5xx", "https://www.hone.care/api/twilio/inbound-sms"]) {
      expect(sameTwilioWebhook(other, BASE), other).toBe(false);
    }
    expect(normalizeTwilioWebhookUrl("ftp://hone.care/x#rp=5xx")).toEqual({ ok: false, reason: "unparseable" });
    expect(normalizeTwilioWebhookUrl(null)).toEqual({ ok: false, reason: "unparseable" });
  });
});

describe("routing uses the same normalizer", () => {
  it("an effective inbound URL with a valid override reaches Hone; an invalid one does not", () => {
    const facts = (url: string) => ({ serviceInboundUrl: url, serviceInboundMethod: "POST", useInboundWebhookOnNumber: false, numberSmsUrl: null });
    expect(inboundReaches(facts(`${BASE}#rp=5xx`), BASE)).toBe("yes");
    expect(inboundReaches(facts(`${BASE}#ct=0`), BASE)).toBe("no");
    expect(inboundReaches(facts(`${BASE}?a=b`), BASE)).toBe("no");
  });
});

describe("a recognised override is NOT redelivery evidence: account Webhook Rules take precedence", () => {
  it("a matching rule's settings win; an unread rule is unknown", () => {
    const url = normalizeTwilioWebhookUrl(`${BASE}#rp=5xx&rc=3`);
    expect(effectiveConnectionSettings(url, { rp: ["ct"], rc: 1 })).toEqual({ source: "rule", settings: { rp: ["ct"], rc: 1 } });
    expect(effectiveConnectionSettings(url, null)).toEqual({ source: "url", settings: { rp: ["5xx"], rc: 3 } });
    expect(effectiveConnectionSettings(normalizeTwilioWebhookUrl(BASE), null)).toEqual({ source: "default", settings: {} });
    expect(effectiveConnectionSettings(url, undefined)).toEqual({ source: "unknown" });
    expect(effectiveConnectionSettings(normalizeTwilioWebhookUrl(`${BASE}#ct=0`), null)).toEqual({ source: "unknown" });
  });
});
