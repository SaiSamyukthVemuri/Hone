import { describe, expect, it } from "vitest";
import {
  classifyGoogleResponse,
  classifyRefreshResponse,
  classifyThrown,
  parseRetryAfter,
} from "@/lib/google-calendar/sync/errors";

// Phase B2.1: Google error taxonomy + Retry-After parsing.

describe("classifyGoogleResponse: full matrix", () => {
  const cases: Array<[number, unknown, string]> = [
    [200, {}, "success"],
    [204, null, "success"],
    [401, { error: {} }, "token_expired"],
    [404, { error: {} }, "not_found"],
    [409, { error: {} }, "conflict"],
    [412, { error: {} }, "precondition_failed"],
    [429, { error: {} }, "rate_limited"],
    [500, { error: {} }, "transient"],
    [503, { error: {} }, "transient"],
    [408, { error: {} }, "transient"], // Request Timeout is retryable
    [400, { error: {} }, "permanent_error"], // invalid request, unrecoverable
    [405, { error: {} }, "permanent_error"], // unsupported method, unrecoverable
    [422, { error: {} }, "permanent_error"], // other 4xx -> permanent
  ];
  it.each(cases)("status %i -> kind %s", (status, body, kind) => {
    expect(classifyGoogleResponse({ status, parsedBody: body }).kind).toBe(kind);
  });

  it("permanent 4xx (400/405) never retries indefinitely (permanent_error, retryAfter null)", () => {
    const c = classifyGoogleResponse({ status: 400, parsedBody: { error: {} } });
    expect(c.kind).toBe("permanent_error");
    expect(c.retryAfterSeconds).toBeNull();
  });

  it("403 rateLimitExceeded -> rate_limited; insufficientPermissions -> insufficient_scope", () => {
    expect(
      classifyGoogleResponse({ status: 403, parsedBody: { error: { errors: [{ reason: "rateLimitExceeded" }] } } }).kind,
    ).toBe("rate_limited");
    expect(
      classifyGoogleResponse({ status: 403, parsedBody: { error: { errors: [{ reason: "insufficientPermissions" }] } } }).kind,
    ).toBe("insufficient_scope");
  });

  it("unclassified 403 fails toward insufficient_scope (never infinite retry)", () => {
    expect(classifyGoogleResponse({ status: 403, parsedBody: { error: {} } }).kind).toBe("insufficient_scope");
  });

  it("non-2xx with an unparseable body is transient", () => {
    expect(classifyGoogleResponse({ status: 502, parsedBody: null, bodyParseFailed: true }).kind).toBe("transient");
  });

  it("carries a parsed Retry-After on rate limits", () => {
    const c = classifyGoogleResponse({ status: 429, parsedBody: { error: {} }, retryAfterHeader: "120" });
    expect(c.kind).toBe("rate_limited");
    expect(c.retryAfterSeconds).toBe(120);
  });
});

describe("classifyRefreshResponse", () => {
  it("400 invalid_grant -> invalid_grant", () => {
    expect(classifyRefreshResponse({ status: 400, parsedBody: { error: "invalid_grant" } }).kind).toBe("invalid_grant");
  });
  it("400 without invalid_grant is transient", () => {
    expect(classifyRefreshResponse({ status: 400, parsedBody: { error: "invalid_request" } }).kind).toBe("transient");
  });
  it("2xx is success; 503 is transient", () => {
    expect(classifyRefreshResponse({ status: 200, parsedBody: {} }).kind).toBe("success");
    expect(classifyRefreshResponse({ status: 503, parsedBody: {} }).kind).toBe("transient");
  });
});

describe("classifyThrown", () => {
  it("AbortError -> network_timeout; other -> network_error; both transient", () => {
    const t = classifyThrown(Object.assign(new Error("x"), { name: "AbortError" }));
    expect(t.kind).toBe("transient");
    expect(t.code).toBe("network_timeout");
    const n = classifyThrown(new Error("boom"));
    expect(n.kind).toBe("transient");
    expect(n.code).toBe("network_error");
  });
});

describe("parseRetryAfter", () => {
  it("delta-seconds form", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("HTTP-date form (relative to injected now)", () => {
    const now = Date.parse("2026-07-12T00:00:00Z");
    expect(parseRetryAfter("Sun, 12 Jul 2026 00:02:00 GMT", now)).toBe(120);
  });
  it("a past date clamps to 0", () => {
    const now = Date.parse("2026-07-12T00:05:00Z");
    expect(parseRetryAfter("Sun, 12 Jul 2026 00:00:00 GMT", now)).toBe(0);
  });
  it("caps at 21600 and returns null for junk/absent", () => {
    expect(parseRetryAfter("999999")).toBe(21600);
    expect(parseRetryAfter("not-a-date")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});
