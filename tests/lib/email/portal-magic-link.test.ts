import { describe, expect, it } from "vitest";
import { buildPortalMagicLinkEmail } from "@/lib/email/templates/portal-magic-link";

// PR #166. The magic-link expiry was raised from 30 minutes to
// 1 hour to absorb real-world email delivery latency (Chloe's
// "secure link stopped working under 30 mins" bug). The TTL
// constant lives in app/portal/login/actions.ts and the human-
// facing copy lives in this template. This file pins the body
// copy so a drift between the two is caught at test time.

describe("buildPortalMagicLinkEmail", () => {
  it("the subject names the studio and signals freshness", () => {
    const out = buildPortalMagicLinkEmail({
      studioName: "Willow",
      magicLink: "https://example.test/portal/verify/abc123",
    });
    expect(out.subject).toBe("Your new secure Willow sign-in link");
  });

  it("the text body advertises a 1-hour expiry, not 30 minutes", () => {
    const out = buildPortalMagicLinkEmail({
      studioName: "Willow",
      magicLink: "https://example.test/portal/verify/abc123",
    });
    expect(out.text).toContain("This link expires in 1 hour.");
    expect(out.text).not.toMatch(/30 minutes/);
    expect(out.text).not.toMatch(/30 mins?/i);
  });

  it("the HTML body advertises a 1-hour expiry, not 30 minutes", () => {
    const out = buildPortalMagicLinkEmail({
      studioName: "Willow",
      magicLink: "https://example.test/portal/verify/abc123",
    });
    expect(out.html).toContain("This link expires in 1 hour.");
    expect(out.html).not.toMatch(/30 minutes/);
    expect(out.html).not.toMatch(/30 mins?/i);
  });

  it("the body never names the client (no enumeration leak)", () => {
    // Same client-anonymity guarantee PR #127 introduced. PR #166
    // does not loosen it; we only changed the expiry copy.
    const out = buildPortalMagicLinkEmail({
      studioName: "Willow",
      magicLink: "https://example.test/portal/verify/abc123",
    });
    expect(out.text).not.toMatch(/\bclient[_-]?id\b/i);
    // The template does not accept a client name input at all, so
    // the strongest assertion is on the shape of the input type;
    // we check the body has no name-like greeting structure.
    expect(out.text).not.toMatch(/^Hi [A-Z]/m);
    expect(out.html).not.toMatch(/>Hi [A-Z]/);
  });

  it("the magic link URL appears verbatim in both bodies", () => {
    const link = "https://example.test/portal/verify/XYZ-token-789";
    const out = buildPortalMagicLinkEmail({
      studioName: "Willow",
      magicLink: link,
    });
    expect(out.text).toContain(link);
    expect(out.html).toContain(link);
  });

  it("a studio name with HTML-significant characters is escaped in HTML only", () => {
    const out = buildPortalMagicLinkEmail({
      studioName: "Willow & Co <Pilot>",
      magicLink: "https://example.test/portal/verify/abc",
    });
    expect(out.html).not.toContain("<Pilot>");
    expect(out.html).toContain("&lt;Pilot&gt;");
    expect(out.text).toContain("Willow & Co <Pilot>");
  });

  it("blank studio name falls back to 'your studio'", () => {
    const out = buildPortalMagicLinkEmail({
      studioName: "   ",
      magicLink: "https://example.test/portal/verify/abc",
    });
    expect(out.text).toContain("your studio client portal");
    expect(out.html).toContain("your studio");
  });
});
