import { defineConfig, devices } from "@playwright/test";
import { GOOGLE_E2E_APP_ORIGIN, GOOGLE_WEB_SERVER_ENV } from "./e2e-google/helpers/google-env";

// Dedicated synthetic-Google browser E2E lane. Physically isolated from the
// ordinary browser-e2e lane (mirrors playwright.payment.config.ts):
//   * testDir ./e2e-google (the ordinary config's testDir ./e2e never matches
//     these specs, so the fake-Google env can only ever be present here),
//   * its own webServer started with the server-only fake-Google markers + FAKE
//     Google OAuth client,
//   * reuseExistingServer:false so it never attaches to a non-fake dev server.
//
// Runs against a LOCAL Next production build + LOCAL Supabase only
// (e2e/helpers/local-env.ts hard-fails on any hosted URL). The fake-Google guard
// is fail-closed, so no real Google request can leave this lane. Port 3111 in CI
// (pinned by HONE_E2E_PORT) on its OWN runner → no collision with the other
// browser lanes; locally the port is derived per worktree (TEST-PORT-01,
// scripts/worktree-resources.mjs) and reuse is off, so a candidate collision
// fails loudly rather than sharing another worktree's server.
export default defineConfig({
  testDir: "./e2e-google",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: GOOGLE_E2E_APP_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run e2e:google-server",
    url: GOOGLE_E2E_APP_ORIGIN,
    env: GOOGLE_WEB_SERVER_ENV,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
