import { describe, expect, it } from "vitest";
import { addressedHost, isSameOriginPost } from "@/lib/records/print/same-origin";

const h = (o: Record<string, string>) => new Headers(o);
const OWN = "https://app.hone.test";

// The three proxy shapes met in the browser run, plus a cross-origin POST in each. Request.url is NOT an input.
describe("same-origin POST from headers alone", () => {
  describe("shape 1: the proxy keeps the browser's Host", () => {
    const host = "app.hone.test";
    it.each([false, true])("accepts the own origin (platform=%s)", (platform) => {
      expect(isSameOriginPost(h({ host, origin: OWN }), platform)).toBe(true);
    });
    it.each([false, true])("refuses a cross-origin POST (platform=%s)", (platform) => {
      for (const origin of ["https://evil.test", "https://app.hone.test.evil.test", "null", "https://app.hone.test:8443", "https://u@app.hone.test", "https://app.hone.test/x", ""]) {
        expect(isSameOriginPost(h({ host, origin }), platform), origin).toBe(false);
      }
      expect(isSameOriginPost(h({ host }), platform), "no Origin").toBe(false);
    });
  });

  describe("shape 2: the proxy keeps Host and adds x-forwarded-host", () => {
    const base = { host: "app.hone.test", "x-forwarded-host": "app.hone.test", "x-forwarded-proto": "https" };
    it.each([false, true])("accepts the own origin (platform=%s)", (platform) => {
      expect(isSameOriginPost(h({ ...base, origin: OWN }), platform)).toBe(true);
    });
    it.each([false, true])("refuses a cross-origin POST (platform=%s)", (platform) => {
      expect(isSameOriginPost(h({ ...base, origin: "https://evil.test" }), platform)).toBe(false);
    });
  });

  describe("shape 3: the proxy rewrites Host to an internal name and sets x-forwarded-host", () => {
    const base = { host: "app.internal.test", "x-forwarded-host": "app.hone.test", "x-forwarded-proto": "https" };
    it("ON the platform (which sets x-forwarded-host itself) the own origin is accepted", () => {
      expect(isSameOriginPost(h({ ...base, origin: OWN }), true)).toBe(true);
    });
    it("OFF the platform x-forwarded-host is a client's word and is ignored: the own origin is refused rather than guessed", () => {
      expect(isSameOriginPost(h({ ...base, origin: OWN }), false)).toBe(false);
    });
    it("refuses a cross-origin POST on and off the platform", () => {
      for (const platform of [false, true]) expect(isSameOriginPost(h({ ...base, origin: "https://evil.test" }), platform)).toBe(false);
    });
    it("refuses an attacker who supplies BOTH Origin and x-forwarded-host off the platform", () => {
      const forged = { host: "app.hone.test", "x-forwarded-host": "evil.test", origin: "https://evil.test" };
      expect(isSameOriginPost(h(forged), false)).toBe(false);
    });
  });

  describe("Sec-Fetch-Site comes first and Origin never overrides it", () => {
    it.each([
      ["same-origin", true],
      ["same-site", false],
      ["cross-site", false],
      ["none", false],
    ])("%s -> %s even with a matching Origin", (site, ok) => {
      expect(isSameOriginPost(h({ host: "app.hone.test", origin: OWN, "sec-fetch-site": site }), false)).toBe(ok);
    });
    it("same-origin vouches even for 'Origin: null' and with no usable host", () => {
      expect(isSameOriginPost(h({ origin: "null", "sec-fetch-site": "same-origin" }), false)).toBe(true);
    });
  });

  it("no Host and no forwarded host: nothing to compare, refused", () => {
    expect(isSameOriginPost(h({ origin: OWN }), false)).toBe(false);
    expect(addressedHost(h({}), true)).toBeNull();
  });

  it("the first of several forwarded hosts is the one the platform set", () => {
    expect(addressedHost(h({ "x-forwarded-host": "app.hone.test, other.test", host: "x" }), true)).toBe("app.hone.test");
    expect(addressedHost(h({ "x-forwarded-host": "app.hone.test", host: "x" }), false)).toBe("x");
  });
});
