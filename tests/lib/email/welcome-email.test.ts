import { describe, expect, it } from "vitest";
import { buildWelcomeEmail } from "@/lib/email/templates/welcome";

const BASE = {
  ownerDisplayName: "Alex Rivera",
  ownerEmail: "alex@example.com",
  studioName: "Rivera Electrolysis",
  bookingUrl: "https://hone.care/book/rivera",
};

describe("buildWelcomeEmail — one truthful invitation email", () => {
  const email = buildWelcomeEmail(BASE);

  it("uses an invitation subject naming the studio", () => {
    expect(email.subject).toBe(
      "You've been invited to Rivera Electrolysis on Hone",
    );
  });

  it("says INVITED (not 'added'), and mentions confirming current policies", () => {
    expect(email.text.toLowerCase()).toContain("you've been invited");
    expect(email.text.toLowerCase()).not.toContain("has been added");
    expect(email.text.toLowerCase()).not.toContain("now has access");
    expect(email.text.toLowerCase()).toContain(
      "confirm the current terms of service and privacy policy",
    );
  });

  it("works for an existing account too (mentions using an existing account)", () => {
    expect(email.text.toLowerCase()).toContain(
      "if you already have a hone account",
    );
  });

  it("includes the sign-in CTA and the booking URL", () => {
    expect(email.html).toContain("https://hone.care/login");
    expect(email.html).toContain("https://hone.care/book/rivera");
    expect(email.text).toContain("https://hone.care/book/rivera");
  });

  it("is onboarding, not marketing (no sales copy)", () => {
    expect(email.html.toLowerCase()).not.toMatch(
      /\bfree trial\b|\bupgrade\b|\bsale\b|\bdiscount\b/,
    );
  });
});

describe("buildWelcomeEmail — safety", () => {
  it("escapes HTML in the studio name", () => {
    const email = buildWelcomeEmail({
      ...BASE,
      studioName: "<script>x</script> & Co",
    });
    expect(email.html).not.toContain("<script>x</script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&amp; Co");
  });

  it("omits the booking-page line when there is no URL", () => {
    const email = buildWelcomeEmail({ ...BASE, bookingUrl: "" });
    expect(email.html).not.toContain("Your booking page");
    expect(email.text).not.toContain("Your booking page");
  });

  it("falls back to the email address when no display name is given", () => {
    const email = buildWelcomeEmail({ ...BASE, ownerDisplayName: null });
    expect(email.html).toContain("alex@example.com");
  });
});
