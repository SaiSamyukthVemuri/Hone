import { describe, expect, it } from "vitest";

import { RETURN_TARGETS, returnToDestination, returnToKeyFor } from "@/lib/auth/return-to";

// HON-7 / HON-104. The sign-in return allow-list is exact. These pin what it REFUSES, so that when the queue's path is later changed the allow-list can
// be extended by reviewed lines and never loosened. Nothing here changes the allow-list.

describe("return-to refuses every lookalike of an allowed page", () => {
  const PATHS = [
    "/settings/Waitlist", "/SETTINGS/waitlist", "/settings//waitlist", "//settings/waitlist", "/settings/waitlist//", "/settings/waitlist/.",
    "/settings/waitlist/..", "/settings/./waitlist", "/settings/waitlist/replies", "/settings/waitlist/search", "/settings/waitlist/archived",
    "/settings/waitlist/released", "/settings/waitlist/over-invite", "/settings/waitlist%2f", "/settings/waitlist%00", "/settings/waitlist ",
    " /settings/waitlist", "/settings/waitlist;x=1", "/settings/waitlists", "/settings/waitlis", "/settings/waitlist/x", "/waitlist", "/clients/waitlist",
    "https://evil.com/settings/waitlist", "/\\settings/waitlist", "/settings/waitlist\\", "/settings/waitlist\u0000",
  ];
  it.each(PATHS)("%j is not a return target", (p) => {
    expect(returnToKeyFor(p, "")).toBeNull();
    expect(returnToKeyFor(p, "?followup=1")).toBeNull();
  });

  const QUERIES = [
    "?followup=2", "?followup=1&x=1", "?x=1&followup=1", "?followup=1&", "?Followup=1", "?followup", "?followup=", "?followup=1%00", "?followup=%31",
    "? followup=1", "?followup=1#follow-up", "#follow-up", "followup=1", "?a=b", "?", "??followup=1", "?followup=1 ", "?followup[]=1",
  ];
  it.each(QUERIES)("the page with query %j is not a return target", (q) => {
    expect(returnToKeyFor("/settings/waitlist", q)).toBeNull();
  });

  it("non-string input is refused", () => {
    expect(returnToKeyFor(undefined as unknown as string, "")).toBeNull();
    expect(returnToKeyFor("/settings/waitlist", null as unknown as string)).toBeNull();
    expect(returnToDestination(undefined)).toBeNull();
    expect(returnToDestination({ toString: () => "waitlist" })).toBeNull();
    expect(returnToDestination("WAITLIST")).toBeNull();
    expect(returnToDestination("waitlist ")).toBeNull();
    expect(returnToDestination("__proto__")).toBeNull();
    expect(returnToDestination("constructor")).toBeNull();
  });
});

describe("the allow-list stays exactly as reviewed", () => {
  it("has exactly two entries and the two keys resolve to internal single-slash destinations", () => {
    expect(RETURN_TARGETS.map((t) => t.key)).toEqual(["waitlist_followup", "waitlist"]);
    for (const t of RETURN_TARGETS) {
      expect(t.destination).toMatch(/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?:#[A-Za-z0-9_-]+)?$/);
      expect(t.destination.startsWith("//")).toBe(false);
      expect(t.destination.startsWith(t.pathname)).toBe(true);
    }
  });
  it("a request resolves to the SAME entry's destination, and the fragment lives only in the destination", () => {
    expect(returnToDestination(returnToKeyFor("/settings/waitlist", "?followup=1"))).toBe("/settings/waitlist#follow-up");
    expect(returnToDestination(returnToKeyFor("/settings/waitlist/", ""))).toBe("/settings/waitlist");
    for (const t of RETURN_TARGETS) expect(t.query).not.toContain("#");
  });
});
