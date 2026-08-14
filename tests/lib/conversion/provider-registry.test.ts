import { describe, expect, it } from "vitest";
import {
  PROVIDER_REGISTRY,
  getProviderEntry,
  VIDEO_COMING_SOON_FALLBACK,
} from "@/lib/conversion/provider-registry";

const META = getProviderEntry("meta")!;

describe("provider registry: shape", () => {
  it("has all 8 enum providers; Meta is the only available + editable one", () => {
    const ids = PROVIDER_REGISTRY.map((p) => p.provider);
    for (const id of ["meta", "google_ads", "ga4", "tiktok", "pinterest", "linkedin", "microsoft_ads", "custom"]) {
      expect(ids).toContain(id);
    }
    expect(META.status).toBe("available");
    expect(META.editable).toBe(true);
    for (const p of PROVIDER_REGISTRY.filter((x) => x.provider !== "meta")) {
      expect(p.status).toBe("coming_soon");
      expect(p.editable).toBe(false);
    }
  });
});

describe("provider registry: Meta onboarding copy", () => {
  const steps = META.setupSections.flatMap((s) => s.steps).join(" ");
  const titles = META.setupSections.map((s) => s.title);

  it("uses the studio's OWN Meta account, not Hone's", () => {
    expect(steps).toMatch(/studio's OWN Meta Business account/);
    expect(steps).toMatch(/do not use Hone's Meta account/i);
    expect(steps).toMatch(/admin access to the studio's Meta Business portfolio/);
  });
  it("has Pixel/Dataset ID + Conversions API token + Test Event Code + Enable sections", () => {
    expect(titles).toEqual(
      expect.arrayContaining(["Before you start", "Pixel / Dataset ID", "Conversions API token", "Test Event Code", "Enable checkbox"]),
    );
  });
  it("Pixel/Dataset ID steps", () => {
    expect(steps).toMatch(/Data Sources/);
    expect(steps).toMatch(/Copy the Dataset ID \/ Pixel ID/);
  });
  it("Conversions API token steps (generate + never share + rotate)", () => {
    expect(steps).toMatch(/Generate access token/);
    expect(steps).toMatch(/Do not email or share this token/);
    expect(steps).toMatch(/generate a new one and rotate it in Hone/);
  });
  it("Test Event Code steps (copy + clear before real traffic)", () => {
    expect(steps).toMatch(/Test Events/);
    expect(steps).toMatch(/clear the Test Event Code before real traffic/);
  });
  it("token is stored encrypted + only last 4 shown", () => {
    expect(steps).toMatch(/stores the token encrypted and only ever shows the last 4 characters/);
  });
  it("Enable checkbox gated on consent + privacy setup", () => {
    expect(steps).toMatch(/Keep disabled until you are ready to test/);
    expect(steps).toMatch(/Enable only after privacy\/cookie consent is set up/);
    expect(steps).toMatch(/only when the client accepted optional marketing\/analytics tracking/);
  });
  it("data-safety note excludes clinical + payment data", () => {
    expect(META.privacyNote).toMatch(/minimal booking conversion event/);
    for (const excluded of ["treatment notes", "intake answers", "body areas", "photos", "contraindications", "appointment notes", "payment/card data"]) {
      expect(META.privacyNote).toContain(excluded);
    }
  });
});

describe("provider registry: coming-soon providers", () => {
  it("each has purpose + future requirements + the architecture note; NO editable flag", () => {
    for (const p of PROVIDER_REGISTRY.filter((x) => x.status === "coming_soon")) {
      expect(p.purpose.length).toBeGreaterThan(0);
      expect(p.requiredFields.length).toBeGreaterThan(0);
      expect(p.editable).toBe(false);
      expect(p.setupSections.flatMap((s) => s.steps).join(" ")).toMatch(/sender is not enabled yet/);
    }
  });
});

describe("provider registry: links are OFFICIAL only; no third-party video", () => {
  const OFFICIAL = [
    "facebook.com", "developers.facebook.com",
    "support.google.com", "developers.google.com",
    "business-api.tiktok.com", "ads.tiktok.com",
    "developers.pinterest.com", "help.pinterest.com",
    "linkedin.com",
    "help.ads.microsoft.com",
  ];
  it("every help link is https + an official provider domain", () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const l of p.helpLinks) {
        expect(l.href.startsWith("https://")).toBe(true);
        expect(OFFICIAL.some((d) => l.href.includes(`//${d}/`) || l.href.includes(`.${d}/`) || l.href.includes(`//${d}`))).toBe(true);
      }
    }
  });
  it("no youtube / random video links; videoUrl is null → fallback used", () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.videoUrl).toBeNull();
      for (const l of p.helpLinks) {
        expect(l.href).not.toMatch(/youtube\.com|youtu\.be|vimeo\.com/i);
      }
    }
    expect(VIDEO_COMING_SOON_FALLBACK).toMatch(/Video walkthrough: coming soon/);
  });
});
