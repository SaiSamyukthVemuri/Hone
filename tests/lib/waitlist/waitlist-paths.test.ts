import { describe, expect, it } from "vitest";

import { WAITLIST_DECLINE_OWNER_PATH } from "@/lib/email/templates/waitlist-decline-owner";
import { WAITLIST_OFFER_DECLINED_HREF } from "@/lib/notifications/waitlist-offer-declined";
import { OVER_INVITE_LINK_PATH } from "@/components/waitlist/over-invite-link";
import { RETURN_TARGETS, returnToDestination } from "@/lib/auth/return-to";
import {
  WAITLIST_ARCHIVED_PATH,
  WAITLIST_OVER_INVITE_PATH,
  WAITLIST_PATH,
  WAITLIST_RELEASED_PATH,
  WAITLIST_REPLIES_PATH,
  WAITLIST_SEARCH_PATH,
} from "@/lib/waitlist/paths";

// The constant was introduced without changing a single URL. These are the strings the code spelled out BEFORE it, written literally here on purpose: if a
// value in lib/waitlist/paths.ts ever changes, this test says so, and that change is then a deliberate move (with redirects), not an accident.

describe("the waitlist path constants are the pre-existing strings, byte for byte", () => {
  it("the six paths", () => {
    expect(WAITLIST_PATH).toBe("/settings/waitlist");
    expect(WAITLIST_SEARCH_PATH).toBe("/settings/waitlist/search");
    expect(WAITLIST_REPLIES_PATH).toBe("/settings/waitlist/replies");
    expect(WAITLIST_ARCHIVED_PATH).toBe("/settings/waitlist/archived");
    expect(WAITLIST_RELEASED_PATH).toBe("/settings/waitlist/released");
    expect(WAITLIST_OVER_INVITE_PATH).toBe("/settings/waitlist/over-invite");
  });
  it("the persisted and emailed links built from them are unchanged", () => {
    expect(WAITLIST_DECLINE_OWNER_PATH).toBe("/settings/waitlist?followup=1#follow-up");
    expect(WAITLIST_OFFER_DECLINED_HREF).toBe("/settings/waitlist#follow-up");
    expect(OVER_INVITE_LINK_PATH).toBe("/settings/waitlist/over-invite");
  });
  it("the sign-in return table is unchanged", () => {
    expect(RETURN_TARGETS).toEqual([
      { key: "waitlist_followup", pathname: "/settings/waitlist", query: "?followup=1", destination: "/settings/waitlist#follow-up" },
      { key: "waitlist", pathname: "/settings/waitlist", query: "", destination: "/settings/waitlist" },
    ]);
    expect(returnToDestination("waitlist_followup")).toBe("/settings/waitlist#follow-up");
    expect(returnToDestination("waitlist")).toBe("/settings/waitlist");
  });
});
