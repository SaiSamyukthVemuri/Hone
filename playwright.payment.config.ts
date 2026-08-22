import { defineConfig, devices } from "@playwright/test";
import {
  PAYMENT_E2E_APP_ORIGIN,
  PAYMENT_WEB_SERVER_ENV,
} from "./e2e-payment/helpers/payment-env";

// Dedicated payment browser E2E lane (PR #419). Physically isolated from the
// ordinary browser-e2e lane:
//   * testDir ./e2e-payment (the ordinary config's testDir ./e2e never matches
//     these specs, so the fake-Stripe env can only ever be present here),
//   * its own webServer started with the server-only fake-Stripe markers,
//   * reuseExistingServer:false so it never attaches to a non-fake dev server.
//
// It runs against a LOCAL Next production build + the LOCAL Supabase stack only
// (e2e/helpers/local-env.ts hard-fails on any hosted URL). Fake Stripe is enabled
// ONLY for this server (HONE_E2E_FAKE_STRIPE=1 + a valid HONE_E2E_RUN_ID, no
// Vercel markers), so no real charge, refund, email, or SMS can leave this lane.
//
// PORT. In CI this is still 3111 (the proven magic-link origin), pinned by
// HONE_E2E_PORT on the job; the payment job also runs on its OWN runner, so
// there is no collision with the ordinary browser-e2e job. LOCALLY the port is
// derived per worktree (TEST-PORT-01, scripts/worktree-resources.mjs), so two
// worktrees do not silently share a server: a candidate collision fails loudly.
// reuseExistingServer:false already kept this lane from attaching to a non-fake
// dev server and is unchanged.
// iPad viewport on chromium (not the webkit iPad preset) so the job reuses the
// already-installed chromium.
export default defineConfig({
  testDir: "./e2e-payment",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: PAYMENT_E2E_APP_ORIGIN,
    // iPad-sized viewport (Chloe charges from an iPad) without pulling in the
    // webkit iPad device preset: chromium is the only browser CI installs.
    viewport: { width: 1080, height: 810 },
    hasTouch: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run e2e:payment-server",
    url: PAYMENT_E2E_APP_ORIGIN,
    env: PAYMENT_WEB_SERVER_ENV,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
