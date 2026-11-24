import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OVER_INVITE_LINK_HELP, OVER_INVITE_LINK_LABEL, OVER_INVITE_LINK_PATH, OverInviteLink } from "@/components/waitlist/over-invite-link";
import { readFileSync } from "node:fs";

// The owner's way into the invite-beyond-the-estimate page: shown to an owner with plain wording, rendered as NOTHING (not hidden) for anyone else.
describe("the over-invite link on the Waitlist page", () => {
  it("an owner sees one link to the page, with the plain label and sentence", () => {
    const html = renderToStaticMarkup(createElement(OverInviteLink, { isOwner: true }));
    expect(html).toContain(`href="${OVER_INVITE_LINK_PATH}"`);
    expect(OVER_INVITE_LINK_PATH).toBe("/waitlist/over-invite");
    expect(html).toContain(OVER_INVITE_LINK_LABEL);
    expect(html).toContain(OVER_INVITE_LINK_HELP);
    expect(OVER_INVITE_LINK_LABEL).toBe("Invite beyond the estimate");
    expect(OVER_INVITE_LINK_HELP).toBe("Choose waiting clients to invite even when the week looks full. You confirm once; sending continues in the background.");
  });
  it("anyone else gets no markup at all, not a hidden element", () => {
    for (const v of [false, undefined, null, "owner", 1] as unknown[]) {
      expect(renderToStaticMarkup(createElement(OverInviteLink, { isOwner: v as boolean }))).toBe("");
    }
  });
  it("the Waitlist page passes the same owner check the page itself uses, and nothing else", () => {
    const page = readFileSync("app/(app)/settings/waitlist/page.tsx", "utf8");
    expect(page).toContain('<OverInviteLink isOwner={practitioner.role === "owner"} />');
    expect(page.match(/<OverInviteLink/g)).toHaveLength(1);
  });
});
