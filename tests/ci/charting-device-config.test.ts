import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The HON-80 device matrix is a separate config that only re-selects projects. These pin that it cannot change isolation or turn the switch on.
const cfg = readFileSync("playwright.charting.config.ts", "utf8");
const spec = readFileSync("e2e/charting-new-view.spec.ts", "utf8");

describe("playwright.charting.config.ts", () => {
  it("extends the ordinary config, so global setup, the app server and its guards are the same ones", () => {
    expect(cfg).toMatch(/import base from "\.\/playwright\.config"/);
    expect(cfg).toMatch(/\.\.\.base,/);
    expect(cfg).not.toMatch(/webServer|globalSetup|globalTeardown|baseURL|reuseExistingServer/);
  });
  it("only ever selects the charting spec, once per device", () => {
    const matches = [...cfg.matchAll(/testMatch: MATCH/g)].length;
    expect(matches).toBe(6);
    expect(cfg).toMatch(/const MATCH = \/charting-new-view\\\.spec\\\.ts\$\//);
  });
  it("covers desktop, iPhone and Android portrait, iPad both ways, and WebKit only when opted in", () => {
    for (const n of ["desktop-chromium", "iphone-portrait", "android-portrait", "ipad-portrait", "ipad-landscape", "webkit-charting"]) expect(cfg).toContain(`name: "${n}"`);
    expect(cfg).toMatch(/HONE_E2E_WEBKIT === "1"[\s\S]*webkit-charting/);
  });
  it("never sets the rollout setting itself", () => {
    expect(cfg.replace(/\/\/.*$/gm, "")).not.toMatch(/HONE_CHARTING_NEW_VIEW_STUDIO_IDS/);
  });
});

describe("e2e/charting-new-view.spec.ts", () => {
  it("is skipped unless the local server was started with the rollout setting set to all", () => {
    expect(spec).toMatch(/test\.skip\(process\.env\.HONE_CHARTING_NEW_VIEW_STUDIO_IDS !== "all"/);
  });
  it("uses only the local synthetic seed and reaches no hosted or provider endpoint", () => {
    expect(spec).toMatch(/seedE2eStudio\(\)/);
    expect(spec).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1)/);
    expect(spec).not.toMatch(/supabase\.co|stripe\.com|vercel\.app/);
  });
  it("the payment-lane spec is opt-in the same way and reaches no real provider", () => {
    const pay = readFileSync("e2e-payment/charting-new-view-payment.spec.ts", "utf8");
    expect(pay).toMatch(/test\.skip\(process\.env\.HONE_CHARTING_NEW_VIEW_STUDIO_IDS !== "all"/);
    expect(pay).toMatch(/api\\\.stripe\\\.com/);
    expect(pay).toMatch(/configureFakeStripeOutcome/);
    expect(pay).not.toMatch(/supabase\.co|vercel\.app|sk_live|pk_live/);
  });
  it("proves the rollout setting reached the server instead of skipping silently", () => {
    expect(spec).toMatch(/the switch must exist: start the app server with HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all/);
  });
});
