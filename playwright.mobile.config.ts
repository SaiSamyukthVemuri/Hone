import { defineConfig, devices } from "@playwright/test";
import {
  PAYMENT_E2E_APP_ORIGIN,
  PAYMENT_WEB_SERVER_ENV,
} from "./e2e-payment/helpers/payment-env";

// Mobile-completion browser E2E lane (Chloe workflow fix).
//
// Exercises the mobile-primary journey that broke on Chloe's iPhone: Mark
// completed → checkout → charge, now driven through the in-DOM ConfirmDialog
// that replaced native window.confirm(), plus the optional internal note and
// the in-place "Run charge" CTA.
//
// ENGINE NOTE. The reproduction target is iOS Safari (WebKit), but this lane
// runs the CHROMIUM engine at iPhone dimensions (iPhone 13 viewport + iOS UA +
// hasTouch), plus a Pixel 5 control. The repo's E2E harness is hard-wired to a
// plain-http http://localhost:3111 origin (e2e/helpers/local-env.ts refuses any
// other), and a real WebKit context upgrades every localhost subresource to
// https (no hydration) and drops Secure cookies over http (auth fails), so a
// real-WebKit lane needs an HTTPS E2E harness, which is a separate infra
// follow-up (see the PR's follow-up list). The ConfirmDialog under test is
// standard in-DOM markup with no engine-specific APIs: the WebKit-specific
// failure mode was the native window.confirm dialog, which this PR removes, so
// the Chromium iPhone-profile run gives high confidence for the fix itself.
//
// Same LOCAL-only, no-secrets posture as the payment lane: it reuses
// PAYMENT_WEB_SERVER_ENV, so the guarded fake Stripe is enabled ONLY here and in
// the payment lane (HONE_E2E_FAKE_STRIPE=1 + a per-run HONE_E2E_RUN_ID, no Vercel
// markers, sk_test_dummy), no real charge/refund/email/SMS/Google can leave the
// lane; the journey additionally asserts zero real provider egress. Port 3111
// (the proven magic-link redirect / site_url origin); the mobile job runs on its
// own CI runner so there is no port collision, and reuseExistingServer is off in
// CI. Locally it may reuse an already-running e2e server so lanes can share a
// build.
export default defineConfig({
  testDir: "./e2e-mobile",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // One worker: the specs share the local DB + the run-scoped fake Stripe ledger
  // and each seeds its own uniquely-scoped scenario, so serial keeps them clean.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: PAYMENT_E2E_APP_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile-iphone",
      // iPhone 13 viewport + iOS Safari UA + hasTouch, on the Chromium engine
      // (see ENGINE NOTE). This is the primary iPhone-dimension run.
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
    {
      name: "mobile-control",
      // Pixel 5 (Chromium mobile), the control that proves the fix is not
      // iPhone-viewport-specific.
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run e2e:payment-server",
    url: PAYMENT_E2E_APP_ORIGIN,
    env: PAYMENT_WEB_SERVER_ENV,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
