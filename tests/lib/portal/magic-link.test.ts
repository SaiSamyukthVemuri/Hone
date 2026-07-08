import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PORTAL_MAGIC_LINK_TTL_MS } from "@/lib/portal/magic-link";
import { buildPortalMagicLinkEmail } from "@/lib/email/templates/portal-magic-link";

describe("PORTAL_MAGIC_LINK_TTL_MS — 60 min, in sync with the public action", () => {
  it("is 60 minutes", () => {
    expect(PORTAL_MAGIC_LINK_TTL_MS).toBe(60 * 60 * 1000);
  });
  it("matches the public self-request TTL (drift guard)", () => {
    const publicAction = readFileSync(
      path.resolve(__dirname, "../../../app/portal/login/actions.ts"),
      "utf8",
    );
    expect(publicAction).toMatch(/const MAGIC_LINK_TTL_MS = 60 \* 60 \* 1000;/);
  });
});

describe("portal magic-link email — has the link + 1-hour expiry, NO client/clinical data", () => {
  const email = buildPortalMagicLinkEmail({
    studioName: "Willow Electrolysis",
    magicLink: "https://hone.care/portal/verify/RAWTOKEN123",
  });
  it("contains the secure portal link + a 1-hour expiry note", () => {
    expect(email.text).toContain("https://hone.care/portal/verify/RAWTOKEN123");
    expect(email.text).toMatch(/expires in 1 hour/i);
    expect(email.subject.toLowerCase()).toContain("sign-in link");
  });
  it("takes only studio name + link — cannot carry clinical/intake/payment/client data", () => {
    // The template signature only accepts studioName + magicLink; assert the
    // rendered body has none of the sensitive vocab.
    const blob = `${email.subject} ${email.text} ${email.html}`.toLowerCase();
    for (const bad of ["intake", "treatment", "diagnosis", "card", "consent answer", "health"]) {
      expect(blob).not.toContain(bad);
    }
  });
});
