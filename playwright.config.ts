import { defineConfig, devices } from "@playwright/test";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "./e2e/helpers/local-env";

// Browser E2E lane (PR #227). One browser (Chromium), one core flow
// (the treatment-memory loop), against a LOCAL Next dev server and
// the LOCAL Supabase stack only:
//
//   supabase start          # full local stack (auth + Mailpit)
//   supabase db reset --local
//   npm run test:e2e
//
// e2e/helpers/local-env.ts hard-fails if anything points at a hosted
// Supabase project, so this lane cannot run against production. The
// suite assumes a DISPOSABLE local database (seeded rows are unique
// per run and are not cleaned up; reset wipes them), which also
// respects the 0087 clinical delete hardening: no hard deletes.
export default defineConfig({
  // E2E SCHEMA PREFLIGHT. Refuses to run when the local Supabase stack's applied
  // migrations do not match the migrations THIS checkout defines. Every browser
  // lane reaches the same stack (local-env's endpoints are literals), so a
  // reset from another worktree's branch would otherwise let this lane test its
  // application against that branch's schema and report green.
  // One shared module, deliberately: see e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup",
  // Re-checks at the END that the database is still the one the preflight
  // verified. The preflight is a snapshot; the stack is shared, so a reset
  // landing mid-run would otherwise produce a green run against a schema
  // this lane never verified.
  globalTeardown: "./e2e/global-teardown",
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E_APP_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // HON-62 WebKit proof. Present ONLY when HONE_E2E_WEBKIT=1, which only the
    // non-required `webkit-hon-62` CI job sets, so every other run sees exactly
    // the one chromium project. Scoped to the native time-input spec: WebKit is
    // the engine behind iPad Safari, where the weekly-hours fields are used.
    ...(process.env.HONE_E2E_WEBKIT === "1"
      ? [
          {
            name: "webkit-hon-62",
            testMatch: /(availability-hours-editor|webkit-time-input-key-probe)\.spec\.ts$/,
            // The app CSP's upgrade-insecure-requests is applied by WebKit to
            // http://localhost (Chromium exempts localhost), so every script,
            // style and font was rewritten to https://localhost:3111 and failed
            // the TLS handshake: no hydration, a permanently disabled login
            // button (run 40077309473). Bypass the CSP in this test browser
            // only; the app's CSP is unchanged and the chromium lanes keep
            // exercising it.
            use: { ...devices["Desktop Safari"], bypassCSP: true },
          },
          // CLN-006 mounted-keyboard and focus cases in WebKit (non-required
          // job only). Scoped by file AND by title so the rest of these two
          // specs, which Chromium already runs in full, is not repeated here.
          {
            name: "webkit-cln-006",
            testMatch: /(finish-appointment-mobile|fett-photos-touch-floor)\.spec\.ts$/,
            grep: /aftercare warning keyboard stays contained|every photo control measures at least 44px/,
            use: { ...devices["Desktop Safari"], bypassCSP: true },
          },
        ]
      : []),
  ],
  webServer: {
    // PRODUCTION server, not `next dev`: the dev watcher recompiles
    // whenever Playwright writes artifacts, which Fast-Refreshes the
    // page mid-test and aborts in-flight server actions. A built
    // server is deterministic and matches what CI would run.
    command: "npm run e2e:server",
    url: E2E_APP_ORIGIN,
    env: E2E_WEB_SERVER_ENV,
    // TEST-PORT-01. This was `!process.env.CI`, i.e. TRUE locally, which is how
    // a run started in one worktree attached to another worktree's server on the
    // shared port 3111 and reported green about code it never loaded. Hone
    // evidence never reuses a running server: an occupied port fails loudly.
    reuseExistingServer: false,
    // A preserved-stack cold build exceeded five minutes before any browser
    // case started (HON-18 f7d7, 2026-10-21). Allow compilation/typechecking
    // and server startup to finish; the selected test deadlines stay intact.
    timeout: 600_000,
  },
});
