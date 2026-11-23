import { describe, expect, it } from "vitest";

import { redirectForLegacyWaitlistPath } from "@/lib/waitlist/path-redirects";

// The redirect map is pure and NOT wired anywhere. It is proven here so the move can wire it without redesigning it.

const NEW = "/waitlist";

describe("redirectForLegacyWaitlistPath", () => {
  it.each([
    ["/settings/waitlist", "", "/waitlist"],
    ["/settings/waitlist/", "", "/waitlist"],
    ["/settings/waitlist/search", "", "/waitlist/search"],
    ["/settings/waitlist/replies", "", "/waitlist/replies"],
    ["/settings/waitlist/archived", "", "/waitlist/archived"],
    ["/settings/waitlist/released", "", "/waitlist/released"],
    ["/settings/waitlist/over-invite", "", "/waitlist/over-invite"],
  ])("%s%s goes to %s", (p, q, to) => {
    expect(redirectForLegacyWaitlistPath(p, q, NEW)).toBe(to);
  });

  it("carries the query string over untouched, including the follow-up flag and a page number", () => {
    expect(redirectForLegacyWaitlistPath("/settings/waitlist", "?followup=1", NEW)).toBe("/waitlist?followup=1");
    expect(redirectForLegacyWaitlistPath("/settings/waitlist", "?section=waiting&page=2", NEW)).toBe("/waitlist?section=waiting&page=2");
    expect(redirectForLegacyWaitlistPath("/settings/waitlist/search", "?q=a%20b", NEW)).toBe("/waitlist/search?q=a%20b");
  });

  it("works for a nested new base", () => {
    expect(redirectForLegacyWaitlistPath("/settings/waitlist/replies", "?x=1", "/clients/waitlist")).toBe("/clients/waitlist/replies?x=1");
  });

  it.each([
    "/settings", "/settings/waitlist/x", "/settings/waitlist/replies/extra", "/settings/Waitlist", "/settings//waitlist", "/settings/waitlists",
    "/settings/waitlist/..", "/settings/waitlist%2fsearch", "", "/", "/waitlist", "https://evil.com/settings/waitlist", "//settings/waitlist",
  ])("%j is not a waitlist path: null", (p) => {
    expect(redirectForLegacyWaitlistPath(p, "", NEW)).toBeNull();
  });

  it("a query that does not start with ? is refused, and non-strings are refused", () => {
    expect(redirectForLegacyWaitlistPath("/settings/waitlist", "followup=1", NEW)).toBeNull();
    expect(redirectForLegacyWaitlistPath(undefined as unknown as string, "", NEW)).toBeNull();
    expect(redirectForLegacyWaitlistPath("/settings/waitlist", null as unknown as string, NEW)).toBeNull();
  });

  it.each(["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "waitlist", "", "/waitlist/", "/waitlist?x=1", "/waitlist#x", "/wait list", "/a//b", "/waitlist\r\nx", "/%2Fevil"])(
    "a new base of %j is refused: it cannot become an open redirect",
    (base) => {
      expect(() => redirectForLegacyWaitlistPath("/settings/waitlist", "", base)).toThrow();
    },
  );
});
