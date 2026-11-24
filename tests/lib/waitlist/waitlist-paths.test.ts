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

// Pin public URLs used by the owner workspace and the existing stored bell links.

describe("the owner waitlist uses its canonical workspace URLs", () => {
  it("the six paths", () => {
    expect(WAITLIST_PATH).toBe("/waitlist");
    expect(WAITLIST_SEARCH_PATH).toBe("/waitlist/search");
    expect(WAITLIST_REPLIES_PATH).toBe("/waitlist/replies");
    expect(WAITLIST_ARCHIVED_PATH).toBe("/waitlist/archived");
    expect(WAITLIST_RELEASED_PATH).toBe("/waitlist/released");
    expect(WAITLIST_OVER_INVITE_PATH).toBe("/waitlist/over-invite");
  });
  it("emails and new links target the workspace, and the database bell still targets its forwarded URL", () => {
    expect(WAITLIST_DECLINE_OWNER_PATH).toBe("/waitlist?followup=1#follow-up");
    expect(WAITLIST_OFFER_DECLINED_HREF).toBe("/settings/waitlist#follow-up");
    expect(OVER_INVITE_LINK_PATH).toBe("/waitlist/over-invite");
  });
  it("the two allowed sign-in keys now land at the workspace", () => {
    expect(RETURN_TARGETS).toEqual([
      { key: "waitlist_followup", pathname: "/waitlist", query: "?followup=1", destination: "/waitlist#follow-up" },
      { key: "waitlist", pathname: "/waitlist", query: "", destination: "/waitlist" },
    ]);
    expect(returnToDestination("waitlist_followup")).toBe("/waitlist#follow-up");
    expect(returnToDestination("waitlist")).toBe("/waitlist");
  });
});
