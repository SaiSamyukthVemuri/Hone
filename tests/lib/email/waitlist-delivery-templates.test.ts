import { describe, expect, it } from "vitest";
import {
  buildWaitlistInvitationEmail,
  waitlistInvitationSubject,
} from "@/lib/email/templates/waitlist-invitation";
import {
  buildWaitlistRecipientProofEmail,
  minutesPhrase,
} from "@/lib/email/templates/waitlist-recipient-proof";

// WAIT DELIVERY-01. These two templates are the visible half of a design whose
// whole point is that the invitation link and the recipient proof are SEPARATE
// authorities. The tests below are mostly about what must NOT appear in each
// message, because that is where the separation is actually enforced: a
// template that helpfully included the other factor would silently collapse
// two channels into one and nothing else in the stack would notice.
//
// Pure templates: no provider, no I/O, no env. Nothing here can send email.

const URL = "https://example.test/waitlist/invitation/RAWTOKEN";
// An ABSOLUTE instant, already formatted by the caller in the studio's zone.
// Not a duration: a duration is only true at one moment, and a delayed send
// makes it false.
const EXPIRY_LABEL = "Thursday, September 10, 2026 at 1:00 PM EDT";

describe("waitlist invitation email", () => {
  it("names the studio in the subject and carries no operator prefix", () => {
    // [HONE WAITLIST] is the STUDIO-facing marker operators build inbox rules
    // on (templates/new-client-waitlist.ts). It is operational vocabulary and
    // must not reach a prospect.
    expect(waitlistInvitationSubject("Willow")).toBe(
      "Your invitation to book · Willow",
    );
    expect(waitlistInvitationSubject("Willow")).not.toContain("[HONE WAITLIST]");
  });

  it("carries the invitation URL in both bodies", () => {
    const out = buildWaitlistInvitationEmail({
      studioName: "Willow",
      invitationUrl: URL,
      expiresAtLabel: EXPIRY_LABEL,
    });
    expect(out.text).toContain(URL);
    expect(out.html).toContain(URL);
  });

  it("tells the recipient the link alone will not complete anything", () => {
    // The link RESOLVES; it does not MUTATE. If this sentence disappears, a
    // recipient reasonably assumes clicking through is the whole transaction
    // and the second factor arrives as an unexplained obstacle.
    const out = buildWaitlistInvitationEmail({
      studioName: "Willow",
      invitationUrl: URL,
      expiresAtLabel: EXPIRY_LABEL,
    });
    expect(out.text).toContain("opening the link is not enough on its own");
    expect(out.html).toContain("opening the link is not enough on its own");
  });

  it("renders the caller's absolute expiry and hard-codes no TTL", () => {
    // The TTL is owned by issue_new_client_waitlist_invitation (0189:
    // p_ttl_hours, default 72, clamped 1..168) and stored on expires_at. This
    // module must never become a second opinion about it.
    const out = buildWaitlistInvitationEmail({
      studioName: "Willow",
      invitationUrl: URL,
      expiresAtLabel: "Tuesday, September 8, 2026 at 9:00 AM EDT",
    });
    expect(out.text).toContain("expires Tuesday, September 8, 2026 at 9:00 AM EDT");
    expect(out.html).toContain("expires Tuesday, September 8, 2026 at 9:00 AM EDT");
    expect(out.text).not.toContain("72");
    // No relative wording anywhere: that is the shape that went false on a
    // delayed send.
    expect(out.text).not.toMatch(/expires in \d+/);
  });

  it("falls back rather than rendering a gap when the studio name is blank", () => {
    const out = buildWaitlistInvitationEmail({
      studioName: "   ",
      invitationUrl: URL,
      expiresAtLabel: EXPIRY_LABEL,
    });
    expect(out.subject).toBe("Your invitation to book · your studio");
    expect(out.text).not.toContain("  at ,");
  });

  it("escapes a studio name that would otherwise inject markup", () => {
    const out = buildWaitlistInvitationEmail({
      studioName: '<script>alert(1)</script>',
      invitationUrl: URL,
      expiresAtLabel: EXPIRY_LABEL,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("waitlist recipient proof email", () => {
  const base = {
    studioName: "Willow",
    code: "H4K2QF7P",
    windowMinutes: 20,
    action: "book" as const,
  };

  it("renders the code the caller supplied, in both bodies", () => {
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("H4K2QF7P");
    expect(out.html).toContain("H4K2QF7P");
  });

  it("NEVER puts the code in the subject", () => {
    // A subject reaches a locked-screen notification and a shared inbox's
    // preview pane. The recipient is already looking at the page that asked
    // for the code, so the usual bank-style trade buys nothing here.
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.subject).toBe("Your Willow confirmation code");
    expect(out.subject).not.toContain(base.code);
  });

  it("NEVER carries the invitation URL — that would rejoin the two factors", () => {
    // The single most important assertion in this file. An email holding both
    // the link and the code is one forward away from handing over the entire
    // authority the split exists to divide.
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).not.toContain(URL);
    expect(out.html).not.toContain(URL);
    expect(out.text).not.toMatch(/https?:\/\//);
    expect(out.html).not.toMatch(/href=/);
  });

  it("states the consequence, and distinguishes decline from book", () => {
    // A proof minted for a decline must not read as a booking confirmation.
    const book = buildWaitlistRecipientProofEmail(base);
    const decline = buildWaitlistRecipientProofEmail({
      ...base,
      action: "decline",
    });
    expect(book.text).toContain("book your consultation with Willow");
    expect(decline.text).toContain("turn down the opening at Willow");
    expect(decline.text).not.toContain("book your consultation");
  });

  it("says an earlier code has stopped working", () => {
    // Mitigation for subject threading: Gmail/Outlook collapse repeated proof
    // emails into one thread and can show a stale one first. The body has to
    // explain the failure the reader is about to hit.
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("any earlier code has already stopped working");
    expect(out.html).toContain("any earlier code has already stopped working");
  });

  it("says the code is single-use and renders the caller's TTL", () => {
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("expires in 20 minutes");
    expect(out.text).toContain("used once");
  });

  it("reassures a recipient who did not request it", () => {
    const out = buildWaitlistRecipientProofEmail(base);
    expect(out.text).toContain("nothing will happen without the code");
  });

  it("escapes a studio name that would otherwise inject markup", () => {
    const out = buildWaitlistRecipientProofEmail({
      ...base,
      studioName: '"><img src=x onerror=alert(1)>',
    });
    expect(out.html).not.toContain("<img");
    expect(out.html).toContain("&lt;img");
  });
});

describe("minutesPhrase", () => {
  it("renders whole minutes and singularises one", () => {
    expect(minutesPhrase(30)).toBe("30 minutes");
    expect(minutesPhrase(1)).toBe("1 minute");
    expect(minutesPhrase(19.6)).toBe("19 minutes");
  });

  it("never renders a zero or negative window", () => {
    // A proof whose remaining window has already elapsed should read as a
    // vague reassurance, not as "expires in 0 minutes" — which looks broken
    // and invites the recipient to give up rather than request a new code.
    expect(minutesPhrase(0)).toBe("a few minutes");
    expect(minutesPhrase(-5)).toBe("a few minutes");
    expect(minutesPhrase(0.4)).toBe("a few minutes");
    expect(minutesPhrase(Number.NaN)).toBe("a few minutes");
    expect(minutesPhrase(Number.POSITIVE_INFINITY)).toBe("a few minutes");
  });
});
