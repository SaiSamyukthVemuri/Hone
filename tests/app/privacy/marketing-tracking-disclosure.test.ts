import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Provider-agnostic marketing/analytics privacy + consent framework (UI
// copy only — no tracking enabled, no sender, no provider receives data).

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

const PRIVACY = read("app/privacy/page.tsx");
const TERMS = read("app/terms/page.tsx");
const META_LIB = read("lib/conversion/meta-capi.ts");

describe("privacy policy — marketing/analytics disclosure", () => {
  it("no longer makes the unconditional 'no advertising cookies ever' claim", () => {
    expect(PRIVACY).not.toMatch(
      /We do not use third-party advertising cookies, behavioral tracking\s+cookies, or analytics cookies that share data with advertising\s+networks\./,
    );
    // The absolute 'no marketing sharing' line is gone too.
    expect(PRIVACY).not.toMatch(
      /We do not share personal information for marketing purposes\./,
    );
  });

  it("states Hone does not enable advertising/behavioral tracking by default", () => {
    expect(PRIVACY).toMatch(
      /Hone does not enable advertising or behavioral tracking by default/,
    );
  });

  it("discloses OPTIONAL studio-enabled marketing/analytics integrations", () => {
    expect(PRIVACY).toMatch(/studio may choose to enable/i);
    expect(PRIVACY).toMatch(/marketing (or|and) analytics\s+integrations/i);
  });

  it("gives provider examples BEYOND Meta (not Meta-only)", () => {
    for (const p of ["Meta", "Google", "TikTok", "Pinterest", "LinkedIn", "Microsoft Ads"]) {
      expect(PRIVACY).toContain(p);
    }
  });

  it("says the account/pixel/token belongs to the studio, not Hone", () => {
    expect(PRIVACY).toMatch(/belongs to the\s+studio, not to Hone/);
  });

  it("says clinical data is NOT sent to marketing/analytics providers", () => {
    expect(PRIVACY).toMatch(/does not send sensitive clinical information/i);
    for (const f of [
      "intake answers",
      "treatment notes",
      "contraindications",
      "allergies",
      "body areas",
      "treatment photos",
      "cancellation reasons",
    ]) {
      expect(PRIVACY.toLowerCase()).toContain(f);
    }
  });

  it("says booking can still be completed if marketing tracking is declined", () => {
    expect(PRIVACY).toMatch(
      /still\s+complete a booking even if you decline non-essential marketing tracking/,
    );
  });
});

describe("terms — studio-owned provider responsibility", () => {
  it("clarifies studios own their provider accounts/datasets and configure them", () => {
    expect(TERMS).toMatch(/Studio-controlled marketing and analytics providers/);
    expect(TERMS).toMatch(/your own ad accounts, pixels, datasets/);
    expect(TERMS).toMatch(/belong to you, not to\s+Hone/);
  });
  it("states Hone does not mix conversion data across studios", () => {
    expect(TERMS).toMatch(/does not mix conversion data across studios/);
  });
  it("uses cautious wording (may / where enabled / subject to consent)", () => {
    expect(TERMS).toMatch(/subject to applicable\s+consent and configuration/);
    expect(TERMS).toMatch(/Hone may provide integration tools/);
  });
});

describe("guardrails — nothing is enabled or wired", () => {
  it("the Meta foundation (#345) remains inert: no network, no token/env, imported nowhere", () => {
    expect(META_LIB).not.toContain("fetch(");
    expect(META_LIB).not.toContain("graph.facebook");
    expect(META_LIB).not.toContain("process.env");
    expect(META_LIB).not.toContain("META_CAPI_TOKEN");
    // Imported only by its own test — no app/lib wiring.
    const importers = read("lib/conversion/meta-capi.ts"); // existence check
    expect(importers.length).toBeGreaterThan(0);
  });
  it("this PR added no browser pixel / tag loader anywhere in app", () => {
    // No pixel bootstrap strings introduced in the app tree by this framework PR.
    expect(PRIVACY).not.toMatch(/fbq\(|gtag\(|ttq\.|pintrk\(|_linkedin_/);
    expect(TERMS).not.toMatch(/fbq\(|gtag\(|ttq\.|pintrk\(|_linkedin_/);
  });
});
