import { describe, expect, it } from "vitest";
import { buildWelcomeEmail } from "@/lib/email/templates/welcome";

const BASE = {
  ownerDisplayName: "Alex Rivera",
  ownerEmail: "alex@example.com",
  studioName: "Rivera Electrolysis",
  bookingUrl: "https://hone.care/book/rivera",
};

describe("buildWelcomeEmail — new_owner variant", () => {
  const email = buildWelcomeEmail({ ...BASE, variant: "new_owner" });

  it("uses a welcome subject naming the studio", () => {
    expect(email.subject).toBe(
      "Welcome to Hone — Rivera Electrolysis is ready",
    );
  });

  it("includes the sign-in CTA and the booking URL", () => {
    expect(email.html).toContain("https://hone.care/login");
    expect(email.html).toContain("https://hone.care/book/rivera");
    expect(email.text).toContain("https://hone.care/book/rivera");
  });

  it("mentions the ~5-minute guided setup, not sales copy", () => {
    expect(email.text.toLowerCase()).toContain("five minutes");
    // Onboarding, not marketing — no pricing/sales language.
    expect(email.html.toLowerCase()).not.toMatch(/\bfree trial\b|\bupgrade\b|\bsale\b|\bdiscount\b/);
  });
});

describe("buildWelcomeEmail — existing_account variant", () => {
  const email = buildWelcomeEmail({ ...BASE, variant: "existing_account" });

  it("uses an 'added to a studio' subject (no re-invitation)", () => {
    expect(email.subject).toBe(
      "You've been added to Rivera Electrolysis on Hone",
    );
  });

  it("tells the owner to sign in with their existing account", () => {
    expect(email.text.toLowerCase()).toContain("account you already have");
    expect(email.html).toContain("alex@example.com");
  });
});

describe("buildWelcomeEmail — safety", () => {
  it("escapes HTML in the studio name", () => {
    const email = buildWelcomeEmail({
      ...BASE,
      studioName: "<script>x</script> & Co",
      variant: "new_owner",
    });
    expect(email.html).not.toContain("<script>x</script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&amp; Co");
  });

  it("omits the booking-page line when there is no URL", () => {
    const email = buildWelcomeEmail({
      ...BASE,
      bookingUrl: "",
      variant: "new_owner",
    });
    expect(email.html).not.toContain("Your booking page:");
    expect(email.text).not.toContain("Your booking page:");
  });

  it("falls back to the email address when no display name is given", () => {
    const email = buildWelcomeEmail({
      ...BASE,
      ownerDisplayName: null,
      variant: "new_owner",
    });
    expect(email.html).toContain("alex@example.com");
  });
});
