import { defineConfig } from "@playwright/test";
import base from "./playwright.payment.config";

// HON-80: the payment-lane spec for the charting New view, run on a PRE-BUILT server. The payment config's server command always rebuilds
// (`next build && next start`) under a 300 s timeout, which a cold build on a busy host exceeds before any test starts. This config extends it and changes
// ONLY how the already-built server is started (`npm run start`) and how long to wait for it. The server env, fake-Stripe markers, ports, globalSetup and
// the no-reuse rule are the payment config's own. Build first with the payment config's exact env (see the HON-80 run notes), then:
//   HONE_CHARTING_NEW_VIEW_STUDIO_IDS=all npx playwright test --config playwright.charting-payment.config.ts
export default defineConfig({
  ...base,
  testMatch: /charting-new-view-payment\.spec\.ts$/,
  webServer: { ...base.webServer!, command: "npm run start", timeout: 300_000 },
});
