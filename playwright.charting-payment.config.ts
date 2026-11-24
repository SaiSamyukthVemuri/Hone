import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.payment.config";

// HON-80: the payment-lane spec for the charting New view, run on a PRE-BUILT server. The payment config's server command always rebuilds
// (`next build && next start`) under a 300 s timeout, which a cold build on a busy host exceeds before any test starts. This config extends it and changes
// ONLY how the already-built server is started (`npm run start`) and how long to wait for it. The server env, fake-Stripe markers, ports, globalSetup and
// the no-reuse rule are the payment config's own. Build first with the payment config's exact env (see the HON-80 run notes), then:
//   npx playwright test --config playwright.charting-payment.config.ts
// The payment config adds its own WebKit project (quick-checkout keyboard cases, with a `grep`) when HONE_E2E_WEBKIT=1, and a project's own testMatch/grep
// OVERRIDE a top-level testMatch. So this config replaces `projects` entirely: every project here selects only the charting payment spec and sets no grep.
const MATCH = /charting-new-view-payment\.spec\.ts$/;
export default defineConfig({
  ...base,
  testMatch: MATCH,
  projects: [
    { name: "chromium-charting-payment", testMatch: MATCH, use: { ...base.use } },
    ...(process.env.HONE_E2E_WEBKIT === "1"
      ? [
          {
            name: "webkit-charting-payment",
            testMatch: MATCH,
            use: { ...devices["Desktop Safari"], bypassCSP: true, baseURL: base.use?.baseURL, viewport: { width: 1080, height: 810 }, hasTouch: true },
          },
        ]
      : []),
  ],
  webServer: { ...base.webServer!, command: "npm run start", timeout: 300_000 },
});
