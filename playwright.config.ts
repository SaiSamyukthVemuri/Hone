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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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
    timeout: 300_000,
  },
});
