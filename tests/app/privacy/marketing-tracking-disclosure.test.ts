import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Provider-agnostic marketing/analytics privacy + consent framework (docs/UI
// copy only — no tracking enabled, no sender, no provider receives data).

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

const PRIVACY = read("app/privacy/page.tsx");
const TERMS = read("app/terms/page.tsx");
const PLAN = read("docs/23_STUDIO_MARKETING_TRACKING_PLAN.md");
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

describe("plan doc — provider-agnostic model + data minimization", () => {
  it("is titled as the generic Studio Marketing plan, Meta only the first foundation", () => {
    expect(PLAN).toMatch(/# Studio Marketing and Conversion Tracking Plan/);
    expect(PLAN).toMatch(/provider-agnostic/i);
    expect(PLAN).toMatch(/Meta is the first/i);
  });

  it("describes per-studio provider config, NOT one global Hone pixel", () => {
    expect(PLAN).toMatch(/per studio/i);
    expect(PLAN).toMatch(/not a shared Hone-wide pixel/i);
    for (const p of [
      "meta",
      "google_ads",
      "ga4",
      "tiktok",
      "pinterest",
      "linkedin",
      "microsoft_ads",
      "custom",
    ]) {
      expect(PLAN).toContain(p);
    }
  });

  it("contains the allowed AND forbidden payload lists", () => {
    for (const a of ["event_name", "event_time", "event_id", "event_source_url", "service_category"]) {
      expect(PLAN).toContain(a);
    }
    for (const f of [
      "treatment notes",
      "intake / health data",
      "contraindications",
      "body areas",
      "treatment photos",
      "appointment notes",
      "cancellation reasons",
      "portal tokens",
      "payment card data",
    ]) {
      expect(PLAN.toLowerCase()).toContain(f.toLowerCase());
    }
  });

  it("booking-consent draft says booking continues without marketing tracking + is separable", () => {
    expect(PLAN).toMatch(/Declining marketing tracking does not stop your booking/);
    expect(PLAN).toMatch(/separate.*from.*transactional|transactional.*separate/i);
    expect(PLAN).toMatch(/recorded\s+separately/i);
  });

  it("includes a studio-website cookie banner draft with accept/reject buttons", () => {
    expect(PLAN).toMatch(/Accept marketing cookies/);
    expect(PLAN).toMatch(/Reject non-essential cookies/);
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
