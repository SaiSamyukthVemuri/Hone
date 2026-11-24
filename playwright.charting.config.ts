import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// HON-80 device matrix for the charting New view. It EXTENDS the ordinary browser config (same testDir, global setup and teardown, the local-only
// app server and its guards, the same ports and the paired stack check) and replaces only `projects`, so nothing about isolation changes: it never
// touches the tracked ports, supabase/config.toml or e2e/helpers/local-env.ts, and it runs against the LOCAL stack with a synthetic studio only.
//
// Run it (after a heavy-slot grant):
//   npx playwright test --config playwright.charting.config.ts
// The spec sets the platform rollout row on the OWNED LOCAL stack itself (and restores it), so this config can never turn the switch on anywhere else.
//
// ENGINE NOTE, as in the mobile lane: the device profiles (viewport, touch, user agent) run on the Chromium engine that CI installs. Real WebKit is
// the opt-in `webkit-charting` project below (HONE_E2E_WEBKIT=1), which proves WebKit layout and focus behaviour; it does NOT prove the on-screen
// keyboard, which needs a real iOS or macOS Safari check.
const MATCH = /charting-new-view\.spec\.ts$/;
const onChromium = <T extends object>(d: T) => ({ ...d, defaultBrowserType: "chromium" as const });

export default defineConfig({
  ...base,
  // The base config's projects are replaced, never extended: only the charting spec runs, once per device.
  projects: [
    { name: "desktop-chromium", testMatch: MATCH, use: { ...devices["Desktop Chrome"] } },
    { name: "iphone-portrait", testMatch: MATCH, use: onChromium(devices["iPhone 13"]) },
    { name: "android-portrait", testMatch: MATCH, use: { ...devices["Pixel 5"] } },
    { name: "ipad-portrait", testMatch: MATCH, use: onChromium(devices["iPad (gen 7)"]) },
    { name: "ipad-landscape", testMatch: MATCH, use: onChromium(devices["iPad (gen 7) landscape"]) },
    ...(process.env.HONE_E2E_WEBKIT === "1"
      ? [
          {
            name: "webkit-charting",
            testMatch: MATCH,
            // Same reason as the existing webkit projects: WebKit upgrades http://localhost subresources to https under the app's CSP, so the test
            // browser bypasses the CSP. The app's CSP is unchanged.
            use: { ...devices["Desktop Safari"], bypassCSP: true },
          },
        ]
      : []),
  ],
});
