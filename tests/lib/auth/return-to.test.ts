import { describe, expect, it } from "vitest";
import {
  RETURN_TARGETS,
  RETURN_TO_COOKIE,
  returnToDestination,
  returnToKeyFromCookieHeader,
  returnToKeyFor,
} from "@/lib/auth/return-to";

// HON-7. The return-to boundary: a signed-out request maps to a KEY of a fixed table; the key maps to an internal destination. No input is ever used as a destination.

const HOSTILE = [
  "//evil.com",
  "/\\evil.com",
  "https://evil.com",
  "/%2F%2Fevil",
  "javascript:alert(1)",
  "/settings/waitlist%0d%0aLocation:%20https://evil.com",
  "/settings/waitlist\r\nLocation: https://evil.com",
  "/" + "a".repeat(5000),
  "/settings/team",
  "/dashboard",
  "",
];

describe("returnToKeyFor (middleware side)", () => {
  it("maps exactly the allowlisted pages to a key", () => {
    expect(returnToKeyFor("/settings/waitlist", "")).toBe("waitlist");
    expect(returnToKeyFor("/settings/waitlist", "?followup=1")).toBe("waitlist_followup");
    expect(returnToKeyFor("/settings/waitlist/", "?followup=1")).toBe("waitlist_followup");
  });

  it.each(HOSTILE)("a hostile or non-allowlisted path %j yields no key", (p) => {
    expect(returnToKeyFor(p, "")).toBeNull();
    expect(returnToKeyFor(p, "?followup=1")).toBeNull();
  });

  it("any other query, extra parameter, case change or sub-path yields no key", () => {
    for (const [p, q] of [
      ["/settings/waitlist", "?followup=2"],
      ["/settings/waitlist", "?followup=1&x=//evil.com"],
      ["/settings/waitlist", "?next=https://evil.com"],
      ["/settings/waitlist", "?section=entries"],
      ["/Settings/Waitlist", ""],
      ["/settings/waitlist/replies", ""],
      ["/settings/waitlist%2f..%2fteam", ""],
      ["/settings/waitlistx", ""],
    ] as const) expect(returnToKeyFor(p, q), `${p}${q}`).toBeNull();
  });

  it("refuses non-string input", () => {
    expect(returnToKeyFor(undefined as never, "")).toBeNull();
    expect(returnToKeyFor("/settings/waitlist", null as never)).toBeNull();
  });
});

describe("returnToDestination (callback side)", () => {
  it("resolves a known key to its internal destination, with the fragment for the follow-up", () => {
    expect(returnToDestination("waitlist_followup")).toBe("/settings/waitlist#follow-up");
    expect(returnToDestination("waitlist")).toBe("/settings/waitlist");
  });
  it.each([...HOSTILE, "WAITLIST", "waitlist ", 7, null, undefined, ["waitlist"]])("anything that is not exactly a key (%j) resolves to nothing", (v) => {
    expect(returnToDestination(v)).toBeNull();
  });
  it("every destination in the table is a same-origin relative path: one slash, no host, scheme, backslash or control character", () => {
    for (const t of RETURN_TARGETS) {
      expect(t.destination.startsWith("/") && !t.destination.startsWith("//")).toBe(true);
      expect(/[\\\s\u0000-\u001f:]/.test(t.destination.replace("#follow-up", ""))).toBe(false);
    }
  });
});

describe("returnToKeyFromCookieHeader", () => {
  it("reads only a known key", () => {
    expect(returnToKeyFromCookieHeader(`a=b; ${RETURN_TO_COOKIE}=waitlist_followup; c=d`)).toBe("waitlist_followup");
    expect(returnToKeyFromCookieHeader(null)).toBeNull();
    expect(returnToKeyFromCookieHeader("a=b")).toBeNull();
  });
  it.each(HOSTILE)("a cookie carrying %j is ignored", (v) => {
    expect(returnToKeyFromCookieHeader(`${RETURN_TO_COOKIE}=${v}`)).toBeNull();
  });
});
